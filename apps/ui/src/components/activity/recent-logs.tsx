import { models, providers } from "@llmgateway/models";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { LogCard } from "../dashboard/log-card";
import {
	type DateRange,
	DateRangeSelect,
} from "@/components/date-range-select";
import { Button } from "@/lib/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/lib/components/select";
import { useApi } from "@/lib/fetch-client";

import type { Log } from "@llmgateway/db";

const UnifiedFinishReason = {
	COMPLETED: "completed",
	LENGTH_LIMIT: "length_limit",
	CONTENT_FILTER: "content_filter",
	GATEWAY_ERROR: "gateway_error",
	UPSTREAM_ERROR: "upstream_error",
	CANCELED: "canceled",
	UNKNOWN: "unknown",
} as const;
const FINISH_REASONS = ["stop", "length", "error", "content_filter"];

interface RecentLogsProps {
	initialData?:
		| {
				message?: string;
				logs: Log[];
				pagination: {
					nextCursor: string | null;
					hasMore: boolean;
					limit: number;
				};
		  }
		| undefined;
	projectId: string | null;
}

export function RecentLogs({ initialData, projectId }: RecentLogsProps) {
	const router = useRouter();
	const searchParams = useSearchParams();

	// Initialize state from URL parameters
	const [dateRange, setDateRange] = useState<DateRange | undefined>();
	const [finishReason, setFinishReason] = useState<string | undefined>(
		searchParams.get("finishReason") || undefined,
	);
	const [unifiedFinishReason, setUnifiedFinishReason] = useState<
		string | undefined
	>(searchParams.get("unifiedFinishReason") || undefined);
	const [provider, setProvider] = useState<string | undefined>(
		searchParams.get("provider") || undefined,
	);
	const [model, setModel] = useState<string | undefined>(
		searchParams.get("model") || undefined,
	);

	const api = useApi();
	const scrollPositionRef = useRef<number>(0);
	const isFilteringRef = useRef<boolean>(false);

	// Function to update URL with new filter parameters
	const updateUrlWithFilters = useCallback(
		(newParams: Record<string, string | undefined>) => {
			const params = new URLSearchParams(searchParams.toString());

			// Update or remove parameters
			Object.entries(newParams).forEach(([key, value]) => {
				if (value && value !== "all") {
					params.set(key, value);
				} else {
					params.delete(key);
				}
			});

			// Update URL without triggering a page reload
			router.push(`?${params.toString()}`, { scroll: false });
		},
		[router, searchParams],
	);

	// Track scroll position
	useLayoutEffect(() => {
		const handleScroll = () => {
			if (!isFilteringRef.current) {
				scrollPositionRef.current = window.scrollY;
			}
		};

		window.addEventListener("scroll", handleScroll, { passive: true });
		return () => window.removeEventListener("scroll", handleScroll);
	}, []);

	// Restore scroll position after filter changes
	useLayoutEffect(() => {
		if (isFilteringRef.current) {
			window.scrollTo(0, scrollPositionRef.current);
			isFilteringRef.current = false;
		}
	});

	// Updated filter change handler that updates URL
	const handleFilterChange = useCallback(
		(filterKey: string, setter: (value: string | undefined) => void) => {
			return (value: string) => {
				// Mark that we're filtering and save current position
				isFilteringRef.current = true;
				scrollPositionRef.current = window.scrollY;

				const filterValue = value === "all" ? undefined : value;

				// Update state
				setter(filterValue);

				// Update URL
				updateUrlWithFilters({ [filterKey]: filterValue });
			};
		},
		[updateUrlWithFilters],
	);

	// Build query parameters - only include defined values
	const queryParams: Record<string, string> = {
		orderBy: "createdAt_desc",
	};

	if (dateRange?.start) {
		queryParams.startDate = dateRange.start.toISOString();
	}
	if (dateRange?.end) {
		queryParams.endDate = dateRange.end.toISOString();
	}
	if (finishReason && finishReason !== "all") {
		queryParams.finishReason = finishReason;
	}
	if (unifiedFinishReason && unifiedFinishReason !== "all") {
		queryParams.unifiedFinishReason = unifiedFinishReason;
	}
	if (provider && provider !== "all") {
		queryParams.provider = provider;
	}
	if (model && model !== "all") {
		queryParams.model = model;
	}
	if (projectId) {
		queryParams.projectId = projectId;
	}

	const shouldUseInitialData =
		!dateRange && // No date range selected (date range is not in URL initially)
		finishReason === (searchParams.get("finishReason") || undefined) &&
		unifiedFinishReason ===
			(searchParams.get("unifiedFinishReason") || undefined) &&
		provider === (searchParams.get("provider") || undefined) &&
		model === (searchParams.get("model") || undefined);

	const {
		data,
		isLoading,
		error,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = api.useInfiniteQuery(
		"get",
		"/logs",
		{
			params: {
				query: queryParams,
			},
		},
		{
			enabled: !!projectId,
			initialData:
				shouldUseInitialData && initialData
					? {
							pages: [
								{
									...initialData,
									logs: initialData.logs.map((log) => ({
										...log,
										createdAt:
											log.createdAt instanceof Date
												? log.createdAt.toISOString()
												: log.createdAt,
										updatedAt:
											log.updatedAt instanceof Date
												? log.updatedAt.toISOString()
												: log.updatedAt,
									})),
								},
							],
							pageParams: [undefined],
						}
					: undefined,
			initialPageParam: undefined,
			refetchOnWindowFocus: false,
			staleTime: 5 * 60 * 1000, // 5 minutes to prevent unnecessary refetches
			getNextPageParam: (lastPage) => {
				return lastPage?.pagination?.hasMore
					? lastPage.pagination.nextCursor
					: undefined;
			},
		},
	);

	// Flatten all pages into a single array of logs
	const allLogs = data?.pages.flatMap((page) => page?.logs || []) || [];

	const handleDateRangeChange = (_value: string, range: DateRange) => {
		setDateRange(range);
		// Update URL with date range
		updateUrlWithFilters({
			startDate: range.start?.toISOString(),
			endDate: range.end?.toISOString(),
		});
	};

	if (!projectId) {
		return (
			<div className="py-8 text-center text-muted-foreground">
				<p>Please select a project to view recent logs.</p>
			</div>
		);
	}

	return (
		<div
			className="space-y-4 max-w-full overflow-hidden"
			style={{ scrollBehavior: "auto" }}
		>
			<div className="flex flex-wrap gap-2 mb-4 sticky top-0 bg-background z-10 py-2">
				<DateRangeSelect onChange={handleDateRangeChange} />

				<Select
					onValueChange={handleFilterChange("finishReason", setFinishReason)}
					value={finishReason || "all"}
				>
					<SelectTrigger className="w-[180px]">
						<SelectValue placeholder="Filter by reason" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All reasons</SelectItem>
						{FINISH_REASONS.map((reason) => (
							<SelectItem key={reason} value={reason}>
								{reason}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Select
					onValueChange={handleFilterChange(
						"unifiedFinishReason",
						setUnifiedFinishReason,
					)}
					value={unifiedFinishReason || "all"}
				>
					<SelectTrigger className="w-[200px]">
						<SelectValue placeholder="Filter by unified reason" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All unified reasons</SelectItem>
						{Object.entries(UnifiedFinishReason).map(([key, value]) => (
							<SelectItem key={value} value={value}>
								{key
									.toLowerCase()
									.replace(/_/g, " ")
									.replace(/\b\w/g, (l) => l.toUpperCase())}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Select
					onValueChange={handleFilterChange("provider", setProvider)}
					value={provider || "all"}
				>
					<SelectTrigger className="w-[160px]">
						<SelectValue placeholder="Filter by provider" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All providers</SelectItem>
						{providers.map((p) => (
							<SelectItem key={p.id} value={p.id}>
								{p.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Select
					onValueChange={handleFilterChange("model", setModel)}
					value={model || "all"}
				>
					<SelectTrigger className="w-[180px]">
						<SelectValue placeholder="Filter by model" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All models</SelectItem>
						{models.map((m) => (
							<SelectItem key={m.id} value={m.id}>
								{m.id}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{isLoading ? (
				<div>Loading...</div>
			) : error ? (
				<div>Error loading logs</div>
			) : (
				<div className="space-y-4 max-w-full">
					{allLogs.length ? (
						<>
							{allLogs.map((log) => (
								<LogCard
									key={log.id}
									log={{
										...log,
										createdAt: new Date(log.createdAt),
										updatedAt: new Date(log.updatedAt),
										toolChoice: log.toolChoice as any, // somehow toolChoice is unknown
									}}
								/>
							))}

							{hasNextPage && (
								<div className="flex justify-center pt-4">
									<Button
										onClick={() => fetchNextPage()}
										disabled={isFetchingNextPage}
										variant="outline"
									>
										{isFetchingNextPage ? "Loading more..." : "Load More"}
									</Button>
								</div>
							)}
						</>
					) : (
						<div className="py-4 text-center text-muted-foreground">
							No logs found matching the selected filters.
							{projectId && (
								<span className="block mt-1 text-sm">Project: {projectId}</span>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
