import type { InjectionKey } from "vue";

export type PullRequestLink = { repository: string; number: number; href: string };
export type PullRequestOpener = (link: PullRequestLink, origin: DOMRect | null) => boolean;

export const PULL_REQUEST_OPENER: InjectionKey<PullRequestOpener | null> = Symbol("pull-request-opener");

export function matchesPullRequestRepository(
  link: PullRequestLink,
  repo: { nameWithOwner: string; url: string } | null,
): boolean {
  if (!repo || repo.nameWithOwner.toLowerCase() !== link.repository.toLowerCase()) return false;
  try {
    return new URL(repo.url).origin === "https://github.com";
  } catch {
    return false;
  }
}

export function parsePullRequestLink(href: string): PullRequestLink | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.hash) return null;
    const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (!match) return null;
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number)) return null;
    return { repository: `${match[1]}/${match[2]}`, number, href };
  } catch {
    return null;
  }
}
