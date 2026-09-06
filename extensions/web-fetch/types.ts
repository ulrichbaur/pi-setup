/** Shared result shapes for the web-fetch extractors. */

export interface ExtractedDocument {
  title: string;
  content: string;
}

export interface FetchResult extends ExtractedDocument {
  url: string;
  error: string | null;
}
