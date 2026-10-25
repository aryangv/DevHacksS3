import type { ModelClient } from "../interfaces/p1";
import {
  type ModelProposal,
  type ModelRequest,
  type ModelResponse,
  type ModelStepOutput,
  PROMPT_TAGS,
} from "../schemas/model";

export type ModelResponder = (
  request: ModelRequest,
  callIndex: number,
) => string | ModelStepOutput | Record<string, unknown> | Error;

/** Fake model client with scripted outputs (spec 18.3 item 6). Records every request for assertions. */
export class FakeModelClient implements ModelClient {
  readonly id = "fake";
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responder: ModelResponder = heuristicResponder) {}

  /** Returns `outputs[i]` on the i-th call, then repeats the last one. */
  static scripted(
    outputs: Array<string | ModelStepOutput | Record<string, unknown> | Error>,
  ): FakeModelClient {
    return new FakeModelClient((_req, i) => outputs[Math.min(i, outputs.length - 1)]!);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const i = this.requests.length;
    this.requests.push(request);
    const out = this.responder(request, i);
    if (out instanceof Error) throw out;
    const text = typeof out === "string" ? out : JSON.stringify(out);
    const inputChars = request.system.length + request.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      text,
      stopReason: "end",
      usage: { inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil(text.length / 4) },
      model: "fake-model",
    };
  }

  /** Every prompt string the model was shown (system + messages), for leak tests. */
  allPromptText(): string {
    return this.requests.map((r) => [r.system, ...r.messages.map((m) => m.content)].join("\n")).join("\n");
  }
}

const reply = (text: string): ModelProposal => ({ kind: "reply", text });

/** Text of the last `<message …>…</message>` block in the request. */
export function lastMessageText(request: ModelRequest): string {
  const all = request.messages.map((m) => m.content).join("\n");
  const re = new RegExp(`<${PROMPT_TAGS.message}[^>]*>([\\s\\S]*?)</${PROMPT_TAGS.message}>`, "g");
  let last = "";
  for (const m of all.matchAll(re)) last = m[1] ?? "";
  return last.trim();
}

/**
 * Deterministic stand-in for a real model so the simulator demo runs with no API key. Understands the
 * dinner slice ("dinner under $20", "confirm", "cancel"), a Canvas lookup and a permission change.
 */
export const heuristicResponder: ModelResponder = (request) => {
  const text = lastMessageText(request).toLowerCase();
  const sawToolResult = request.messages.some((m) => m.content.includes(`<${PROMPT_TAGS.toolResult}`));
  const isGroup = request.metadata.purpose.startsWith("group");

  if (sawToolResult) {
    const last = request.messages[request.messages.length - 1]?.content ?? "";
    if (last.includes('status="needs_approval"'))
      return { proposals: [reply("I need your OK first - check the approval message I just sent you.")] };
    if (last.includes('status="denied"'))
      return { proposals: [reply("I can't do that right now - that tool isn't available to you.")] };
    return { proposals: [reply("Here is what I found: you have Problem Set 4 due Oct 27.")] };
  }

  if (isGroup) {
    if (/\b(confirm|lock it in|book it|let'?s do it)\b/.test(text))
      return { proposals: [{ kind: "confirm_task" }] };
    if (/\b(cancel|never ?mind)\b/.test(text)) return { proposals: [{ kind: "cancel_task" }] };
    if (/\b(dinner|lunch|food|eat|order)\b/.test(text)) {
      const dollars = /\$\s?(\d+)/.exec(text);
      return {
        proposals: [
          {
            kind: "start_task",
            taskType: "group_meal",
            params: {
              budgetPerPersonMinor: dollars ? Number(dollars[1]) * 100 : null,
              cuisine: null,
              notes: null,
            },
          },
        ],
      };
    }
    if (/always allow|from now on/.test(text)) {
      return {
        proposals: [
          {
            kind: "permission_change",
            change: {
              action: "set",
              target: "canvas",
              mode: "allow",
              scope: "everywhere",
              duration: "forever",
            },
          },
        ],
      };
    }
    return { proposals: [reply("Hi! I can plan group meals - try: dinner tonight under $20 each.")] };
  }

  if (/always allow|from now on/.test(text)) {
    return {
      proposals: [
        {
          kind: "permission_change",
          change: {
            action: "set",
            target: "canvas__submit_comment",
            mode: "allow",
            scope: "this_conversation",
            duration: "forever",
          },
        },
      ],
    };
  }
  if (/\b(assignment|homework|canvas|due)\b/.test(text)) {
    return {
      proposals: [
        {
          kind: "tool_call",
          tool: "canvas__list_assignments",
          argsJson: "{}",
          rationale: "user asked about assignments",
        },
      ],
    };
  }
  return { proposals: [reply(`Got it. You said: ${lastMessageText(request).slice(0, 200)}`)] };
};
