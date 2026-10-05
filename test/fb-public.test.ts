import { describe, expect, it } from "vitest";
import type { Serp } from "../src/browser/flows/google-search.js";
import { groupsOf } from "../src/sites/fb-public.js";

const result = (url: string, site: string, title = "t") => ({
  position: 1,
  title,
  url,
  site,
  shown: null,
  snippet: "s",
  date: "3 weeks ago",
});

describe("groupsOf", () => {
  it("groups Google's results by Facebook group, posts under each, other sites dropped", () => {
    const serp: Serp = {
      query: "q",
      overview: null,
      ads: [],
      questions: [],
      results: [
        result("https://www.facebook.com/groups/1001/posts/2002/", "Facebook · Owners Club", "a"),
        result("https://www.facebook.com/groups/1001/permalink/2003/", "Facebook", "b"),
        result("https://www.facebook.com/groups/some.club/", "Facebook · Some Club"),
        result("https://www.example.com/groups/1001/", "Example"),
      ],
    };
    expect(groupsOf(serp)).toEqual([
      {
        group: "1001",
        name: "Owners Club",
        url: "https://www.facebook.com/groups/1001/",
        posts: [
          {
            post: "2002",
            url: serp.results[0]?.url,
            title: "a",
            snippet: "s",
            shown: "3 weeks ago",
          },
          {
            post: "2003",
            url: serp.results[1]?.url,
            title: "b",
            snippet: "s",
            shown: "3 weeks ago",
          },
        ],
      },
      {
        group: "some.club",
        name: "Some Club",
        url: "https://www.facebook.com/groups/some.club/",
        posts: [],
      },
    ]);
  });
});
