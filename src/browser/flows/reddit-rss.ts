/**
 * Signed-out Reddit reads without `.json`: since about 2026-10-13 www answers 403 to every
 * signed-out `.json` (the RSS twin and the HTML pages still answer 200). This turns a page's
 * Atom feed into the Data API's own shapes, so a caller reads the same listing either way.
 *
 * Honest by rule: a feed carries no score, comment count, depth, subscriber count, flair, lock
 * or NSFW flag. Those stay absent unless the page's own markup says them (`PostStat`,
 * `CommentStat`, read off the rendered page by the flow); nothing is guessed.
 */

type Obj = Record<string, unknown>;

/** One `<entry>`, still HTML inside. */
export interface AtomEntry {
  /** `t3_abc`, `t1_abc` or `t5_abc`. */
  id: string;
  author: string | null;
  /** The subreddit the entry belongs to (no `r/`). */
  sub: string | null;
  href: string | null;
  published: string | null;
  updated: string | null;
  title: string;
  /** The entry's `<content>`, XML-unescaped: HTML. */
  html: string;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** `&amp;` `&#39;` `&#x27;`: one level, so call it once per layer of escaping. */
export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const tag = (chunk: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(chunk);
  return m ? decode(m[1] ?? "") : null;
};

/** Every entry of an Atom feed, in order. Anything that is not a feed has none. */
export function parseAtom(xml: string): AtomEntry[] {
  const out: AtomEntry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const chunk = m[1] ?? "";
    const id = tag(chunk, "id");
    if (!id || !/^t[1-6]_[a-z0-9]+$/.test(id)) continue;
    const who = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(chunk)?.[1];
    const content = /<content[^>]*>([\s\S]*?)<\/content>/.exec(chunk)?.[1];
    out.push({
      id,
      author: who ? decode(who).replace(/^\/?u\//, "") : null,
      sub: /<category[^>]*\bterm="([^"]*)"/.exec(chunk)?.[1]?.trim() || null,
      href: /<link[^>]*\bhref="([^"]*)"/.exec(chunk)?.[1] ?? null,
      published: tag(chunk, "published"),
      updated: tag(chunk, "updated"),
      title: tag(chunk, "title") ?? "",
      html: content ? decode(content) : "",
    });
  }
  return out;
}

const FENCE = "```";

/** HTML a Reddit feed carries, as the markdown-ish text a post's `selftext` or a comment's `body` holds. */
export function mdOf(html: string): string {
  const m = /<!-- SC_OFF -->([\s\S]*?)<!-- SC_ON -->/.exec(html);
  if (!m) return "";
  const s = (m[1] ?? "")
    .replace(
      /<pre[^>]*>\s*(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/g,
      (_, code: string) => `\n\n${FENCE}\n${code.replace(/\s+$/, "")}\n${FENCE}\n\n`,
    )
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<hr\s*\/?>/g, "\n\n---\n\n")
    .replace(/<h([1-6])[^>]*>/g, (_, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/g, "\n\n")
    .replace(/<blockquote[^>]*>/g, "\n\n> ")
    .replace(/<\/blockquote>/g, "\n\n")
    .replace(/<li[^>]*>/g, "\n- ")
    .replace(/<\/p>/g, "\n\n")
    .replace(/<(strong|b)>/g, "**")
    .replace(/<\/(strong|b)>/g, "**")
    .replace(/<(em|i)>/g, "*")
    .replace(/<\/(em|i)>/g, "*")
    .replace(/<(del|s)>/g, "~~")
    .replace(/<\/(del|s)>/g, "~~")
    .replace(/<\/?code>/g, "`")
    .replace(/<a [^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_, href: string, text: string) => {
      const url = decode(href);
      const label = text.replace(/<[^>]+>/g, "").trim();
      return !label || label === url ? url : `[${label}](${url})`;
    })
    .replace(/<[^>]+>/g, "");
  return decode(s)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The post's own link: its `[link]` anchor (a self post links to itself). */
const linkOf = (html: string): string | null => {
  const m = /<a [^>]*?href="([^"]*)"[^>]*>\s*\[link\]\s*<\/a>/.exec(html);
  return m ? decode(m[1] ?? "") : null;
};

const secs = (iso: string | null): number | undefined => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
};

const pathOf = (href: string | null): string | undefined => {
  if (!href) return undefined;
  try {
    return new URL(href).pathname;
  } catch {
    return undefined;
  }
};

const hostOf = (href: string): string | undefined => {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
};

const defined = (o: Obj): Obj => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

/** A feed entry as the Data API's `{kind, data}` thing; fields the feed lacks are not there. */
export function thingOf(e: AtomEntry): { kind: string; data: Obj } {
  const kind = e.id.slice(0, 2);
  const bare = e.id.slice(3);
  if (kind === "t5") {
    // A subreddit result: its path names it, its title is the API's own `title`, `updated` is its birthday.
    const name = /\/r\/([^/]+)/.exec(e.href ?? "")?.[1];
    const about = /<div>\s*([\s\S]*?)\s*<\/div>\s*<div>\s*<a /.exec(e.html)?.[1];
    return {
      kind,
      data: defined({
        id: bare,
        name: e.id,
        display_name: name,
        title: e.title || undefined,
        public_description: about ? decode(about.replace(/<[^>]+>/g, "")).trim() : undefined,
        created_utc: secs(e.updated),
        url: name ? `/r/${name}/` : undefined,
      }),
    };
  }
  const permalink = pathOf(e.href);
  if (kind === "t1") {
    return {
      kind,
      data: defined({
        id: bare,
        name: e.id,
        body: mdOf(e.html),
        author: e.author ?? undefined,
        permalink,
        subreddit: e.sub ?? undefined,
        link_id: permalink
          ? `t3_${/\/comments\/([a-z0-9]+)\//.exec(permalink)?.[1] ?? ""}`
          : undefined,
        created_utc: secs(e.published ?? e.updated),
      }),
    };
  }
  const link = linkOf(e.html);
  const isSelf = link && e.href ? link === e.href : undefined;
  return {
    kind,
    data: defined({
      id: bare,
      name: e.id,
      title: e.title,
      selftext: mdOf(e.html),
      author: e.author ?? undefined,
      permalink,
      url: link ?? e.href ?? undefined,
      subreddit: e.sub ?? undefined,
      created_utc: secs(e.published ?? e.updated),
      is_self: isSelf,
      domain: isSelf ? (e.sub ? `self.${e.sub}` : undefined) : link ? hostOf(link) : undefined,
    }),
  };
}

/** What the rendered page says of a post; absent when the page does not say it. */
export interface PostStat {
  id: string;
  score?: number | undefined;
  comments?: number | undefined;
  ratio?: number | undefined;
}

/** What the rendered thread says of a comment. `depth` 0 = a top-level comment. */
export interface CommentStat {
  id: string;
  parent?: string | undefined;
  depth: number;
  score?: number | undefined;
}

export interface ThreadDom {
  post: PostStat | null;
  comments: CommentStat[];
}

/** An attribute's number, or nothing: `"11"` is 11, `""`, `"•"` and a missing attribute are not. */
export const num = (v: string | null | undefined): number | undefined => {
  if (v === null || v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const withPostStat = (data: Obj, s: PostStat | undefined): Obj =>
  s
    ? defined({
        ...data,
        score: s.score,
        num_comments: s.comments,
        upvote_ratio: s.ratio,
      })
    : data;

export interface Listing {
  kind: "Listing";
  data: {
    after: string | null;
    before: null;
    children: Array<{ kind: string; data: Obj }>;
  };
}

const listing = (children: Array<{ kind: string; data: Obj }>, after: string | null): Listing => ({
  kind: "Listing",
  data: { after, before: null, children },
});

/**
 * A listing feed (a subreddit's new/hot/top/search, site search, subreddit search, user posts and
 * comments, `/api/info`) as the Data API's listing. `after` is the last thing's name when the feed
 * is full (`limit` things), as the API gives it; a short feed has no next page. `stats` fills a
 * post's score and comment count from the rendered page, only for the posts it names.
 */
export function listingFromAtom(
  xml: string,
  o: {
    limit?: number | undefined;
    paged?: boolean | undefined;
    stats?: readonly PostStat[] | undefined;
  } = {},
): Listing {
  const byId = new Map((o.stats ?? []).map((s) => [s.id, s]));
  const children = parseAtom(xml).map((e) => {
    const t = thingOf(e);
    return t.kind === "t3" ? { ...t, data: withPostStat(t.data, byId.get(e.id)) } : t;
  });
  const full = o.paged !== false && children.length > 0 && children.length >= (o.limit ?? 25);
  const last = children.at(-1)?.data.name;
  return listing(children, full && typeof last === "string" ? last : null);
}

/**
 * A thread feed (`/comments/<id>/.rss`: the post, then its comments flat) as the Data API's pair of
 * listings. The feed has no tree. With the rendered page's markup (`dom`), a reply is left out as
 * the API's listing leaves it (top-level comments only, `replies` never kept) and a top-level
 * comment gets its `parent_id` (the post) and score. A comment the page did not render has
 * neither, and stays in: its depth is not known.
 */
export function threadFromAtom(xml: string, dom?: ThreadDom | null): [Listing, Listing] {
  const entries = parseAtom(xml);
  const postEntry = entries.find((e) => e.id.startsWith("t3_"));
  const post = postEntry ? thingOf(postEntry) : null;
  const postName = postEntry?.id;
  const stat = dom?.post && dom.post.id === postName ? dom.post : undefined;
  const seen = new Map((dom?.comments ?? []).map((c) => [c.id, c]));
  const comments = entries
    .filter((e) => e.id.startsWith("t1_"))
    .flatMap((e) => {
      const t = thingOf(e);
      const c = seen.get(e.id);
      if (!c) return [t];
      if (c.depth > 0) return [];
      return [
        { ...t, data: defined({ ...t.data, parent_id: postName ?? c.parent, score: c.score }) },
      ];
    });
  return [
    listing(post ? [{ kind: post.kind, data: withPostStat(post.data, stat) }] : [], null),
    listing(comments, null),
  ];
}
