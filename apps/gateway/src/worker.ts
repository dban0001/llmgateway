import {
	db,
	log,
	organization,
	eq,
	sql,
	and,
	lt,
	tables,
} from "@llmgateway/db";

import { getProject, getOrganization } from "./lib/cache";
import {
	moveToProcessingQueue,
	removeFromProcessingQueue,
	recoverProcessingQueue,
	getQueueStats,
	LOG_QUEUE,
	LOG_PROCESSING_QUEUE,
} from "./lib/redis";
import { calculateFees } from "../../api/src/lib/fee-calculator";
import { stripe } from "../../api/src/routes/payments";

import type { LogInsertData } from "./lib/logs";

const AUTO_TOPUP_LOCK_KEY = "auto_topup_check";
const LOCK_DURATION_MINUTES = 10;

async function acquireLock(key: string): Promise<boolean> {
	const lockExpiry = new Date(Date.now() - LOCK_DURATION_MINUTES * 60 * 1000);

	try {
		await db
			.delete(tables.lock)
			.where(
				and(eq(tables.lock.key, key), lt(tables.lock.updatedAt, lockExpiry)),
			);

		await db.insert(tables.lock).values({
			key,
		});

		return true;
	} catch (_error) {
		return false;
	}
}

async function releaseLock(key: string): Promise<void> {
	await db.delete(tables.lock).where(eq(tables.lock.key, key));
}

async function processAutoTopUp(): Promise<void> {
	const lockAcquired = await acquireLock(AUTO_TOPUP_LOCK_KEY);
	if (!lockAcquired) {
		return;
	}

	try {
		const orgsNeedingTopUp = await db.query.organization.findMany({
			where: {
				autoTopUpEnabled: {
					eq: true,
				},
			},
		});

		// Filter organizations that need top-up based on credits vs threshold
		const filteredOrgs = orgsNeedingTopUp.filter((org) => {
			const credits = Number(org.credits || 0);
			const threshold = Number(org.autoTopUpThreshold || 10);
			return credits < threshold;
		});

		for (const org of filteredOrgs) {
			try {
				// Check if there's a recent pending or failed auto top-up transaction
				const recentTransaction = await db.query.transaction.findFirst({
					where: {
						organizationId: {
							eq: org.id,
						},
						type: {
							eq: "credit_topup",
						},
					},
					orderBy: {
						createdAt: "desc",
					},
				});

				// Additional check for time constraint (within 1 hour) and status
				if (recentTransaction) {
					const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
					if (recentTransaction.createdAt > oneHourAgo) {
						// Recent transaction within 1 hour, check its status
						if (recentTransaction.status === "pending") {
							console.log(
								`Skipping auto top-up for organization ${org.id}: pending transaction exists`,
							);
							continue;
						}

						if (recentTransaction.status === "failed") {
							console.log(
								`Skipping auto top-up for organization ${org.id}: most recent transaction failed`,
							);
							continue;
						}
					}
				}

				const defaultPaymentMethod = await db.query.paymentMethod.findFirst({
					where: {
						organizationId: {
							eq: org.id,
						},
						isDefault: {
							eq: true,
						},
					},
				});

				if (!defaultPaymentMethod) {
					console.log(
						`No default payment method for organization ${org.id}, skipping auto top-up`,
					);
					continue;
				}

				const topUpAmount = Number(org.autoTopUpAmount || "10");

				const stripePaymentMethod = await stripe.paymentMethods.retrieve(
					defaultPaymentMethod.stripePaymentMethodId,
				);

				const cardCountry = stripePaymentMethod.card?.country;

				// Use centralized fee calculator
				const feeBreakdown = calculateFees({
					amount: topUpAmount,
					organizationPlan: org.plan,
					cardCountry: cardCountry || undefined,
				});

				// Insert pending transaction before creating payment intent
				const pendingTransaction = await db
					.insert(tables.transaction)
					.values({
						organizationId: org.id,
						type: "credit_topup",
						creditAmount: feeBreakdown.baseAmount.toString(),
						amount: feeBreakdown.totalAmount.toString(),
						currency: "USD",
						status: "pending",
						description: `Auto top-up for ${topUpAmount} USD (total: ${feeBreakdown.totalAmount} including fees)`,
					})
					.returning()
					.then((rows) => rows[0]);

				console.log(
					`Created pending transaction ${pendingTransaction.id} for organization ${org.id}`,
				);

				try {
					const paymentIntent = await stripe.paymentIntents.create({
						amount: Math.round(feeBreakdown.totalAmount * 100),
						currency: "usd",
						description: `Auto top-up for ${topUpAmount} USD (total: ${feeBreakdown.totalAmount} including fees)`,
						payment_method: defaultPaymentMethod.stripePaymentMethodId,
						customer: org.stripeCustomerId!,
						confirm: true,
						off_session: true,
						metadata: {
							organizationId: org.id,
							autoTopUp: "true",
							transactionId: pendingTransaction.id,
							baseAmount: feeBreakdown.baseAmount.toString(),
							totalFees: feeBreakdown.totalFees.toString(),
						},
					});

					// Update transaction with Stripe payment intent ID
					await db
						.update(tables.transaction)
						.set({
							stripePaymentIntentId: paymentIntent.id,
							description: `Auto top-up for ${topUpAmount} USD (total: ${feeBreakdown.totalAmount} including fees)`,
						})
						.where(eq(tables.transaction.id, pendingTransaction.id));

					if (paymentIntent.status === "succeeded") {
						console.log(
							`Auto top-up payment intent succeeded immediately for organization ${org.id}: $${topUpAmount}`,
						);
						// Note: The webhook will handle updating the transaction status and adding credits
					} else if (paymentIntent.status === "requires_action") {
						console.log(
							`Auto top-up requires action for organization ${org.id}: ${paymentIntent.status}`,
						);
					} else {
						console.error(
							`Auto top-up payment intent failed for organization ${org.id}: ${paymentIntent.status}`,
						);
						// Mark transaction as failed
						await db
							.update(tables.transaction)
							.set({
								status: "failed",
								description: `Auto top-up failed: ${paymentIntent.status}`,
							})
							.where(eq(tables.transaction.id, pendingTransaction.id));
					}
				} catch (stripeError) {
					console.error(
						`Stripe error for organization ${org.id}:`,
						stripeError,
					);
					// Mark transaction as failed
					await db
						.update(tables.transaction)
						.set({
							status: "failed",
							description: `Auto top-up failed: ${stripeError instanceof Error ? stripeError.message : "Unknown error"}`,
						})
						.where(eq(tables.transaction.id, pendingTransaction.id));
				}
			} catch (error) {
				console.error(
					`Error processing auto top-up for organization ${org.id}:`,
					error,
				);
			}
		}
	} finally {
		await releaseLock(AUTO_TOPUP_LOCK_KEY);
	}
}

export async function processLogQueue(): Promise<void> {
	// Move messages from main queue to processing queue
	const messages = await moveToProcessingQueue(
		LOG_QUEUE,
		LOG_PROCESSING_QUEUE,
		10,
	);

	if (!messages) {
		return;
	}

	try {
		// Parse each message individually and discard only the invalid ones
		const parseResults: {
			data?: LogInsertData;
			error?: Error;
			index: number;
		}[] = messages.map((message, index) => {
			try {
				return { data: JSON.parse(message) as LogInsertData, index };
			} catch (error) {
				return { error: error as Error, index };
			}
		});

		const validMessages = parseResults.filter((r) => r.data);
		const invalidMessages = parseResults.filter((r) => r.error);

		if (invalidMessages.length > 0) {
			console.error(
				`Error parsing ${invalidMessages.length} log messages - discarding invalid messages:`,
				invalidMessages.map((r) => ({
					index: r.index,
					error: r.error?.message,
				})),
			);
		}

		if (validMessages.length === 0) {
			// All messages were invalid, remove them all
			await removeFromProcessingQueue(LOG_PROCESSING_QUEUE, messages.length);
			return;
		}

		const logData = validMessages.map((r) => r.data!);

		const processedLogData = await Promise.all(
			logData.map(async (data) => {
				const organization = await getOrganization(data.organizationId);

				if (organization?.retentionLevel === "none") {
					const {
						messages: _messages,
						content: _content,
						...metadataOnly
					} = data;
					return metadataOnly;
				}

				return data;
			}),
		);

		// Insert logs into database
		await db.insert(log).values(processedLogData as any);

		// Batch update organization credits for better performance
		const creditUpdates = new Map<string, number>();
		const projectCache = new Map<string, any>();

		for (const data of logData) {
			if (!data.cost || data.cached) {
				continue;
			}

			// Cache project lookups to avoid redundant database calls
			let project = projectCache.get(data.projectId);
			if (!project) {
				project = await getProject(data.projectId);
				projectCache.set(data.projectId, project);
			}

			if (project?.mode !== "api-keys") {
				const currentCost = creditUpdates.get(data.organizationId) || 0;
				creditUpdates.set(data.organizationId, currentCost + data.cost);
			}
		}

		// Apply batched credit updates
		for (const [organizationId, totalCost] of creditUpdates) {
			await db
				.update(organization)
				.set({
					credits: sql`${organization.credits} - ${totalCost}`,
				})
				.where(eq(organization.id, organizationId));
		}

		// Only remove from processing queue after successful processing
		await removeFromProcessingQueue(LOG_PROCESSING_QUEUE, messages.length);
	} catch (error) {
		console.error("Error processing log message:", error);
		// Move messages back to main queue for retry
		try {
			await recoverProcessingQueue(LOG_PROCESSING_QUEUE, LOG_QUEUE);
			console.log(
				`Recovered ${messages.length} messages back to main queue for retry`,
			);
		} catch (recoveryError) {
			console.error("Error recovering messages to main queue:", recoveryError);
			// If we can't recover to main queue, at least log the issue
			// Messages will remain in processing queue and be recovered on next worker restart
		}
		// Don't re-throw the error to avoid stopping the worker
		// The error has been logged and messages have been recovered
	}
}

let isWorkerRunning = false;
let shouldStop = false;

export async function startWorker() {
	if (isWorkerRunning) {
		console.log("Worker is already running");
		return;
	}

	isWorkerRunning = true;
	shouldStop = false;
	console.log("Starting log queue worker...");

	// Recover any messages that were being processed when the worker died
	try {
		await recoverProcessingQueue(LOG_PROCESSING_QUEUE, LOG_QUEUE);
		console.log("Recovered any pending messages from processing queue");
	} catch (error) {
		console.error("Error recovering processing queue on startup:", error);
	}

	const count = process.env.NODE_ENV === "production" ? 120 : 5;
	let autoTopUpCounter = 0;
	let queueStatsCounter = 0;
	const queueStatsInterval = process.env.NODE_ENV === "production" ? 60 : 10; // Log queue stats every 60 iterations in prod, 10 in dev

	// eslint-disable-next-line no-unmodified-loop-condition
	while (!shouldStop) {
		try {
			await processLogQueue();

			autoTopUpCounter++;
			if (autoTopUpCounter >= count) {
				await processAutoTopUp();
				autoTopUpCounter = 0;
			}

			// Log queue stats periodically for monitoring
			queueStatsCounter++;
			if (queueStatsCounter >= queueStatsInterval) {
				const stats = await getQueueStats();
				if (stats.mainQueue > 0 || stats.processingQueue > 0) {
					console.log(
						`Queue stats - Main: ${stats.mainQueue}, Processing: ${stats.processingQueue}`,
					);
				}
				queueStatsCounter = 0;
			}

			if (!shouldStop) {
				await new Promise((resolve) => {
					setTimeout(resolve, 1000);
				});
			}
		} catch (error) {
			console.error("Error in log queue worker:", error);
			// Exponential backoff on error to prevent overwhelming the system
			if (!shouldStop) {
				// Start with 5 seconds, can be extended for persistent errors
				const backoffTime = 5000;
				console.log(`Waiting ${backoffTime}ms before retrying after error`);
				await new Promise((resolve) => {
					setTimeout(resolve, backoffTime);
				});
			}
		}
	}

	isWorkerRunning = false;
	console.log("Worker stopped");
}

export async function stopWorker(): Promise<void> {
	if (!isWorkerRunning) {
		console.log("Worker is not running");
		return;
	}

	console.log("Stopping worker...");
	shouldStop = true;

	const pollInterval = 100;
	const maxWaitTime = 15000; // 15 seconds timeout
	const startTime = Date.now();

	// eslint-disable-next-line no-unmodified-loop-condition
	while (isWorkerRunning) {
		if (Date.now() - startTime > maxWaitTime) {
			console.warn("Worker stop timeout exceeded, forcing shutdown");
			break;
		}
		await new Promise((resolve) => {
			setTimeout(resolve, pollInterval);
		});
	}

	console.log("Worker stopped gracefully");
}
