import type { ResolvedMentions, TeamMember } from "./types.ts";
import { TeamRuntimeError } from "./types.ts";

/** Structural exclusions shared by handoff parsing and the final control line. */
export function protocolLines(text: string): Array<{ index: number; text: string }> {
  const result: Array<{ index: number; text: string }> = [];
  let fence: { char: string; length: number } | undefined;
  text.split(/\r?\n/).forEach((line, index) => {
    if (fence) {
      const close = /^ {0,3}(`+|~+)\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = undefined;
      return;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) { fence = { char: open[1][0], length: open[1].length }; return; }
    if (/^(?: {4}|\t)/.test(line) || /^\s*>/.test(line)) return;
    result.push({ index, text: line });
  });
  return result;
}

/** Clowder-style leading handoffs, with quoted/indented examples excluded. */
export function resolveAgentMentions(members: TeamMember[], text: string, currentAgentId?: string): ResolvedMentions {
  const selectors: string[] = [];
  for (const line of protocolLines(text)) {
    const body = line.text.trimStart().replace(/^(?:(?:[-*+]\s+)|(?:\d+[.)]\s+))+/, "");
    let offset = 0;
    while (body[offset] === "@") {
      const token = readMentionToken(body, offset);
      if (!token) break;
      selectors.push(token.raw);
      offset = token.end;
      offset += /^[\s,，、]+/.exec(body.slice(offset))?.[0].length ?? 0;
    }
  }
  const resolved = resolveMentions(members, selectors.join(" "));
  const targets = resolved.targets.filter(id => id !== currentAgentId);
  if (targets.length > 2) throw new TeamRuntimeError("invalid_mention", "Agent handoffs support at most 2 targets; use a user broadcast for independent collection");
  return { ...resolved, targets, body: text };
}

/**
 * Resolves the mention selectors in a Team message.
 *
 * Resolution is deliberately a pure snapshot operation: callers should persist
 * the returned target ids with the message before doing any delivery work.
 */
export function resolveMentions(
  members: TeamMember[],
  text: string,
  defaultAgentId?: string,
): ResolvedMentions {
  const roster = uniqueMembers(members);
  const tokens = scanMentionTokens(text);
  const targets: string[] = [];
  const seenTargets = new Set<string>();
  const selectors: string[] = [];
  const seenSelectors = new Set<string>();

  for (const token of tokens) {
    const selectorKey = normalize(token.raw);
    if (!seenSelectors.has(selectorKey)) {
      seenSelectors.add(selectorKey);
      selectors.push(token.raw);
    }

    for (const member of resolveToken(token, roster)) {
      if (seenTargets.has(member.agentId)) continue;
      seenTargets.add(member.agentId);
      targets.push(member.agentId);
    }
  }

  if (tokens.length === 0 && defaultAgentId !== undefined) {
    const member = roster.find((candidate) => normalize(candidate.agentId) === normalize(defaultAgentId));
    if (!member) {
      throw new TeamRuntimeError(
        "not_found",
        `Default Agent ${JSON.stringify(defaultAgentId)} is not a Team member`,
        { agentId: defaultAgentId },
      );
    }
    if (!member.enabled) {
      throw new TeamRuntimeError(
        "permission_denied",
        `Default Agent ${JSON.stringify(defaultAgentId)} is disabled`,
        { agentId: member.agentId },
      );
    }
    targets.push(member.agentId);
  }

  return {
    targets,
    selectors,
    body: removeTokenSpans(text, tokens),
    explicit: tokens.length > 0,
  };
}

interface MentionToken {
  raw: string;
  value: string;
  start: number;
  end: number;
}

interface ParsedSelector {
  kind: "all" | "name" | "role" | "model" | "agent";
  value: string;
}

function uniqueMembers(members: TeamMember[]): TeamMember[] {
  const result: TeamMember[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    // Agent ids are the stable identity. A malformed duplicate row must not
    // cause the same logical member to become ambiguous or target twice.
    if (seen.has(member.agentId)) continue;
    seen.add(member.agentId);
    result.push(member);
  }
  return result;
}

function resolveToken(token: MentionToken, members: TeamMember[]): TeamMember[] {
  const selector = parseSelector(token);

  if (selector.kind === "all") {
    return members.filter((member) => member.enabled);
  }

  if (selector.kind === "role") {
    return resolveGroupSelector(token, members, (member) => normalize(member.role ?? "") === normalize(selector.value));
  }

  if (selector.kind === "model") {
    return resolveGroupSelector(token, members, (member) => {
      const requested = normalize(selector.value);
      return normalize(member.model) === requested || normalize(`${member.provider}/${member.model}`) === requested;
    });
  }

  if (selector.kind === "agent") {
    const matches = members.filter((member) => normalize(member.agentId) === normalize(selector.value));
    return resolveSingleSelector(token, matches);
  }

  // Name matching has an intentional two-pass precedence rule. An exact Team
  // name wins over every alias, even when an alias on another member matches.
  const exactNames = members.filter((member) => normalize(member.name) === normalize(selector.value));
  if (exactNames.length > 0) return resolveSingleSelector(token, exactNames);

  const aliases = members.filter((member) => (member.aliases ?? []).some((alias) => normalize(alias) === normalize(selector.value)));
  return resolveSingleSelector(token, aliases);
}

function resolveSingleSelector(token: MentionToken, matches: TeamMember[]): TeamMember[] {
  if (matches.length === 0) {
    throw new TeamRuntimeError(
      "not_found",
      `Mention ${JSON.stringify(token.raw)} did not match an enabled Team member`,
      { selector: token.raw },
    );
  }
  if (matches.length > 1) {
    throw new TeamRuntimeError(
      "ambiguous_mention",
      `Mention ${JSON.stringify(token.raw)} matches multiple Team members`,
      { selector: token.raw, candidates: matches.map((member) => member.agentId) },
    );
  }
  if (!matches[0].enabled) {
    throw new TeamRuntimeError(
      "permission_denied",
      `Mention ${JSON.stringify(token.raw)} targets a disabled Team member`,
      { selector: token.raw, agentId: matches[0].agentId },
    );
  }
  return matches;
}

function resolveGroupSelector(
  token: MentionToken,
  members: TeamMember[],
  predicate: (member: TeamMember) => boolean,
): TeamMember[] {
  const matches = members.filter(predicate);
  const enabled = matches.filter((member) => member.enabled);
  if (enabled.length > 0) return enabled;
  if (matches.length > 0) {
    throw new TeamRuntimeError(
      "permission_denied",
      `Mention ${JSON.stringify(token.raw)} only matches disabled Team members`,
      { selector: token.raw, candidates: matches.map((member) => member.agentId) },
    );
  }
  throw new TeamRuntimeError(
    "not_found",
    `Mention ${JSON.stringify(token.raw)} did not match a Team member`,
    { selector: token.raw },
  );
}

function parseSelector(token: MentionToken): ParsedSelector {
  const value = token.value;
  if (!value) {
    throw invalidMention(token, "selector is empty");
  }
  if (normalize(value) === "all" || normalize(value) === "thread") return { kind: "all", value };

  const colon = value.indexOf(":");
  if (colon < 0) return { kind: "name", value };

  const namespace = normalize(value.slice(0, colon));
  const argument = value.slice(colon + 1).trim();
  if (namespace !== "role" && namespace !== "model" && namespace !== "agent") {
    throw invalidMention(token, `unknown selector namespace ${JSON.stringify(value.slice(0, colon))}`);
  }
  if (!argument) throw invalidMention(token, `${namespace} selector value is empty`);
  return { kind: namespace, value: argument };
}

function invalidMention(token: MentionToken, reason: string): TeamRuntimeError {
  return new TeamRuntimeError("invalid_mention", `Invalid mention ${JSON.stringify(token.raw)}: ${reason}`, {
    selector: token.raw,
  });
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function isMentionBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1];
  return !/[\p{L}\p{M}\p{N}_]/u.test(previous);
}

function isMentionAtom(character: string): boolean {
  return /[\p{L}\p{M}\p{N}_./:+~#=\-]/u.test(character);
}

function scanMentionTokens(text: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf("@", index);
    if (at < 0) break;
    index = at + 1;
    if (!isMentionBoundary(text, at)) continue;

    const parsed = readMentionToken(text, at);
    if (!parsed) continue;
    tokens.push(parsed);
    index = parsed.end;
  }
  return tokens;
}

function readMentionToken(text: string, at: number): MentionToken | undefined {
  let cursor = at + 1;
  if (cursor >= text.length) return undefined;

  if (text[cursor] === '"') {
    const quoted = readQuoted(text, cursor, at);
    return quoted;
  }

  const valueStart = cursor;
  while (cursor < text.length && isMentionAtom(text[cursor])) cursor++;
  if (cursor === valueStart) return undefined;

  // Also accept a quoted namespace argument, e.g. @role:"review lead".
  if (text[cursor] === '"' && text.slice(valueStart, cursor).includes(":")) {
    const quoted = readQuoted(text, cursor, at);
    if (!quoted) return undefined;
    return {
      raw: text.slice(at, quoted.end),
      value: text.slice(valueStart, cursor) + quoted.value,
      start: at,
      end: quoted.end,
    };
  }

  return {
    raw: text.slice(at, cursor),
    value: text.slice(valueStart, cursor),
    start: at,
    end: cursor,
  };
}

function readQuoted(text: string, quote: number, at: number): MentionToken | undefined {
  let cursor = quote + 1;
  let value = "";
  let escaped = false;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === "\n" || character === "\r") {
      throw new TeamRuntimeError("invalid_mention", `Invalid mention starting at position ${at}: quoted selector crosses a line`, {
        selector: text.slice(at, cursor),
      });
    }
    if (escaped) {
      value += character;
      escaped = false;
      cursor++;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      cursor++;
      continue;
    }
    if (character === '"') {
      return {
        raw: text.slice(at, cursor + 1),
        value,
        start: at,
        end: cursor + 1,
      };
    }
    value += character;
    cursor++;
  }
  throw new TeamRuntimeError("invalid_mention", `Invalid mention starting at position ${at}: missing closing quote`, {
    selector: text.slice(at),
  });
}

function removeTokenSpans(text: string, tokens: MentionToken[]): string {
  if (tokens.length === 0) return text.trim();
  let cursor = 0;
  let body = "";
  for (const token of tokens) {
    body += text.slice(cursor, token.start);
    cursor = token.end;
  }
  body += text.slice(cursor);
  return body
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}
