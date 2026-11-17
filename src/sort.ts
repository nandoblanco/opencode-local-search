export type SearchSort = "updated" | "relevance" | "newest" | "oldest" | "title" | "context" | "tokens";
export const SEARCH_SORT_LABELS: Record<SearchSort, string> = {
  updated: "Recently updated", relevance: "Relevance", newest: "Newest created",
  oldest: "Oldest created", title: "Title A–Z", context: "Latest context size", tokens: "Total tokens used",
};
