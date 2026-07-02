import { Exa } from 'exa-js';
import type * as t from './types';
import { SafeSearchLevel } from './types';
import { DATE_RANGE } from './schema';

/**
 * Prototype web search via Exa.ai.
 *
 * Exa's search is different from how other web search tools work because it's
 * all in one - it both searches for links & provides reranked highlights of
 * the results.
 *
 * This prototype demonstrates how an Exa-based web search tool could work; a
 * real implementation would involve a lot more work around the path to using
 * this search provider (and adding tests).
 *
 * ------
 *
 * There are a *lot* of parameters for the search function, so I've tried my
 * best to understand/document them.
 *
 * Some of them come from Librechat, but many of them come *from the LLM* when
 * it calls the web search tool. That is, the LLM determines it wants to use
 * web_search, and it calls it with certain parameters.
 *
 * ------
 *
 * The output of this function is processed by `formatSource()` in `format.ts`.
 * That's what is ultimately fed to the LLM, so if you want to understand how
 * the output of this function changes the LLM output, study that function.
 *
 * ------
 *
 * There are a number of polishes / tasks that are left as an exercise to the
 * reader (since we're not sure if we're using Exa yet). In particular:
 *
 * - Implement all remaining TODOs in the prototype (or throw out the prototype
 *   and redo it all).
 * - Add tests for Exa searches and all their possibilities.
 * - Wire up Exa to LibreChat properly (instead of just relying on a single
 *   environment variable for controlling whether we use Exa or not).
 */
export function createPrototypeExaSearch(
  safeSearch: SafeSearchLevel,
  logger: t.Logger
) {
  return async function ({
    query,
    date,
    country,
    maxSources = 5,
    onSearchResults,
  }: {
    // The query string (e.g. "New Jersey unemployment insurance")
    query: string;

    // The country code (e.g. "US"); this parameter is conditionally sent by the
    // LLM's tool call if it thinks that the search results should be from a
    // particular country.
    //
    // (LLM-provided parameter; see `countrySchema`)
    country?: string;

    // The date range to search, such as past day, past week, past month, etc.
    //
    // This is an odd duck of a parameter because it uses the `DATE_RANGE` enum.
    // It's not an actual date range, but individual letters that indicates a
    // past period of time ('h' == 'past hour', 'w' == 'past week', etc.).
    //
    // This is the "quick date range" schema from Serper, but we would have to
    // convert it to actual dates for Exa's API.
    //
    // (LLM-provided parameter; see `dateSchema`)
    date?: DATE_RANGE;

    // `images`, `videos` & `news` are all boolean toggles to *add* searches for
    // these types of results to the query.
    //
    // Exa does not support image or video search, so those can be safely ignored.
    //
    // Exa does allow searching for news, but doing so *replaces* the normal
    // organic search results. As such, it's an open question whether we want to
    // abide by it or not (for now, we're just ignore all three).
    //
    // (LLM-provided parameters; see `imagesSchema`, `videosSchema`, `newsSchema`)
    // images?: boolean;
    // videos?: boolean;
    // news?: boolean;

    // The maximum number of sources to search for a result
    //
    // Note that this doesn't seem to be wired up to LibreChat, so it's always
    // using the default (for better or worse)
    maxSources?: number;

    // A callback for search results, used by LibreChat for managing web search
    onSearchResults: t.SearchToolConfig['onSearchResults'];

    // `proMode` seems to be an unused, vestigial parameter that would skip
    // the search engine entirely and search Wikipedia instead.
    //
    // Because it is completely irrelevant here, I'm not using it
    // proMode?: boolean;
  }): Promise<t.SearchResultData> {
    try {
      const exa = new Exa(process.env.EXA_API_KEY);

      const { startPublishedDate, endPublishedDate } =
        date !== undefined
          ? normalizeDateForExa(date)
          : { startPublishedDate: undefined, endPublishedDate: undefined };

      const exaResults = await exa.search(query, {
        numResults: maxSources,
        userLocation: country,
        contents: {
          highlights: true,
        },
        startPublishedDate,
        endPublishedDate,
        moderation: safeSearch !== 0,
      });

      // TODO: Handle error cases
      // It won't always work when we call `exa.search()`; research what errors
      // can pop up from search and handle them as needed

      const searchResultData: t.SearchResultData = {
        organic: exaResults.results.map((searchResult, position) => {
          return {
            position,
            title: searchResult.title ?? undefined,
            link: searchResult.url,
            date: searchResult.publishedDate,

            // TODO: Double-check that highlights are ordered by highest score first!
            // The formatter only includes up to N highlight characters, so we want
            // to ensure that the best highlights are always included.
            //
            // Alternatively: look into the `max_characters` parameter for highlights
            highlights: searchResult.highlights.map((highlight, index) => {
              return {
                score: searchResult.highlightScores?.at(index) ?? 0,
                text: highlight,
              };
            }),
          };
        }),

        // Note: even though these are listed as optional, LibreChat crashes if
        // they're not returned as empty arrays!
        images: [],
        topStories: [],
        videos: [],
        news: [],
        relatedSearches: [],
      };

      onSearchResults?.({
        data: searchResultData,
        success: true,
      });

      return searchResultData;
    } catch (error) {
      logger.error('Error in search:', error);
      return {
        organic: [],
        topStories: [],
        images: [],
        videos: [],
        news: [],
        relatedSearches: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/**
 * Converts from the DATE_RANGE enum (past hours, days, weeks, etc.) to a date
 * range that Exa can understand.
 */
function normalizeDateForExa(date: DATE_RANGE): {
  startPublishedDate: string;
  endPublishedDate: string;
} {
  const end = new Date();
  const start = new Date();

  switch (date) {
  case DATE_RANGE.PAST_HOUR:
    start.setHours(start.getHours() - 1);
    break;
  case DATE_RANGE.PAST_24_HOURS:
    start.setDate(start.getDate() - 1);
    break;
  case DATE_RANGE.PAST_WEEK:
    start.setDate(start.getDate() - 7);
    break;
  case DATE_RANGE.PAST_MONTH:
    start.setMonth(start.getMonth() - 1);
    break;
  case DATE_RANGE.PAST_YEAR:
    start.setFullYear(start.getFullYear() - 1);
    break;
  }

  return {
    startPublishedDate: start.toISOString(),
    endPublishedDate: end.toISOString(),
  };
}
