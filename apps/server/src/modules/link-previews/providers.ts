// SPDX-License-Identifier: AGPL-3.0-or-later

export interface OembedProvider {
  name: string;
  /** Matches the page's host name (no `www.`). */
  hosts: readonly RegExp[];
  /** The oEmbed endpoint for a page URL. Its host is fixed here, never taken from the message. */
  endpoint(pageUrl: URL): string;
  video?: boolean;
  /** Also read the page itself for a description (the oEmbed answer has none). */
  descriptionFromPage?: boolean;
}

const enc = encodeURIComponent;

/**
 * Providers that publish an oEmbed endpoint usable without an API key. The endpoint hosts are constants, so a
 * message cannot point the server at an arbitrary "oEmbed" address; what comes back is still read as data only.
 */
export const PROVIDERS: readonly OembedProvider[] = [
  {
    name: "YouTube",
    hosts: [/^(m\.|music\.)?youtube\.com$/, /^youtu\.be$/, /^youtube-nocookie\.com$/],
    endpoint: (u) => `https://www.youtube.com/oembed?format=json&url=${enc(u.href)}`,
    video: true,
    descriptionFromPage: true,
  },
  {
    name: "Vimeo",
    hosts: [/^(player\.)?vimeo\.com$/],
    endpoint: (u) => `https://vimeo.com/api/oembed.json?url=${enc(u.href)}`,
    video: true,
  },
  {
    name: "SoundCloud",
    hosts: [/^soundcloud\.com$/],
    endpoint: (u) => `https://soundcloud.com/oembed?format=json&url=${enc(u.href)}`,
  },
  {
    name: "Spotify",
    hosts: [/^open\.spotify\.com$/],
    endpoint: (u) => `https://open.spotify.com/oembed?url=${enc(u.href)}`,
  },
  {
    name: "Bluesky",
    hosts: [/^bsky\.app$/],
    endpoint: (u) => `https://embed.bsky.app/oembed?format=json&url=${enc(u.href)}`,
  },
  {
    // Works without credentials for public posts today; X can change that at any time (23 §8.4).
    name: "X",
    hosts: [/^(mobile\.)?(twitter|x)\.com$/],
    endpoint: (u) => {
      const post = new URL(u.href);
      post.hostname = "twitter.com";
      return `https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${enc(post.href)}`;
    },
  },
];

export function providerFor(u: URL): OembedProvider | null {
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  return PROVIDERS.find((p) => p.hosts.some((re) => re.test(host))) ?? null;
}

/** The whole text of an allow/deny entry matches a host or one of its parents ("example.com" covers "a.example.com"). */
export function domainMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === domain || h.endsWith(`.${domain}`);
}
