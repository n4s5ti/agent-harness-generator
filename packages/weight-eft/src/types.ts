// SPDX-License-Identifier: MIT
//
// @metaharness/weight-eft — shared types (the integration contract).
//
// This package is the bridge from Darwin's gradient-FREE policy evolution
// (evolve the harness, freeze the model) to gradient/weight self-learning on
// the OPEN cheap tier. The exporter reads Darwin's trajectory archive and
// emits standard SFT/DPO training sets; the runner wraps a LoRA tune.
//
// THESIS (honest, bounded): we attack the COST-Pareto axis, NOT the frontier
// ceiling. Distilling the archive's successes into GLM/Qwen via LoRA makes the
// cheap tier resolve more issues on its own, so the cascade escalates to a
// frontier model (Opus/GPT) less often. A 7-14B local tune does NOT crack the
// hard tail (frontier reasoning ceiling). The win is fewer escalations →
// lower $/resolved. Telemetry stays honest about that.
//
// See ADR-198 (weight-EFT), ADR-073 (Darwin archive), ADR-179 (cost-Pareto),
// ADR-182 (cost-cascade), ADR-195 (Phase-2 capability genes).

// ════════════════════════════════════════════════════════════════════════════
// INPUT CONTRACT — Darwin trajectory archive
// ════════════════════════════════════════════════════════════════════════════

/** A chat message in an OpenAI-compatible trajectory. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Text content. May be null on an assistant turn that only emits tool_calls. */
  content: string | null;
  /**
   * Assistant tool-call requests (the ReAct action step). PRESERVED verbatim
   * into the SFT set — the model must learn real tool-use trajectories, so this
   * structure is NEVER flattened to plain text.
   */
  tool_calls?: ToolCall[];
  /** On a `role:'tool'` message, the id of the tool_call it answers. */
  tool_call_id?: string;
  /** Optional name (tool name on a tool message; function name otherwise). */
  name?: string;
}

/** An OpenAI-style tool call (the ReAct action). */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * The tier that produced a trajectory. 'cheap' = the open model the cascade
 * runs first (GLM/Qwen/DeepSeek). 'frontier' = the escalation tier
 * (Opus/GPT/Sonnet). This is the on/off-policy discriminator: only cheap-tier
 * trajectories are on-policy for DPO.
 */
export type PolicyTier = 'cheap' | 'frontier';

/**
 * One trajectory in the Darwin archive: a single solve attempt on a single
 * SWE-bench instance by a single model. This is the clear, documented input
 * contract the exporter codes against. It is reconstructable from the
 * Firestore `darwin_runs` docs + the local prediction/trajectory artifacts
 * (predictions-*.jsonl rows carry instance_id + model_patch; the agentic loop
 * carries the `messages` array with tool_calls — see solve-agentic.mjs).
 */
export interface DarwinTrajectory {
  /** SWE-bench instance id, e.g. "astropy__astropy-14182". The contamination key. */
  instance_id: string;
  /** The model that produced this trajectory, e.g. "z-ai/glm-5.2". */
  model: string;
  /** Which cascade tier this model belongs to (on/off-policy discriminator). */
  tier: PolicyTier;
  /**
   * Gold-resolved status from the OFFICIAL swebench harness (resolved_ids).
   * NEVER from in-loop oracle signals — only conformant gold eval counts as a
   * success for SFT distillation.
   */
  resolved: boolean;
  /**
   * The ReAct message trajectory: system + user(issue) + (assistant tool_calls
   * → tool results)* + final assistant(patch). May be empty for a failed/empty
   * attempt (those become DPO `rejected` candidates).
   */
  messages: ChatMessage[];
  /** The unified diff the attempt produced (may be '' for an empty/failed attempt). */
  model_patch: string;
  /**
   * Best-of-N sample index on this instance (BoN-derived). Lets the DPO pairer
   * find a chosen (resolved) and a rejected (empty/failed) sample from the SAME
   * model on the SAME instance. Default 0 when single-sample.
   */
  sample?: number;
  /** Optional source tag (e.g. "darwin_runs", "predictions-mm25"). Provenance only. */
  source?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// OUTPUT SCHEMAS — canonical/standard (portable to trl / axolotl / unsloth)
// ════════════════════════════════════════════════════════════════════════════

/**
 * One SFT row — OpenAI chat JSONL. The tool_calls structure is preserved so
 * the model learns real tool-use trajectories (not a flattened transcript).
 */
export interface SftRow {
  messages: ChatMessage[];
}

/**
 * One DPO row — TRL/HF CONVERSATIONAL preference schema. ReAct diverges from
 * the first action, so `prompt` = the shared system+issue messages, and
 * chosen/rejected are FULL trajectories from that divergence point.
 */
export interface DpoRow {
  prompt: ChatMessage[];
  chosen: ChatMessage[];
  rejected: ChatMessage[];
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORTER CONFIG + REPORT
// ════════════════════════════════════════════════════════════════════════════

export interface ExportOptions {
  /**
   * THE CONTAMINATION GUARD (non-negotiable). Instance ids reserved for
   * evaluation. ANY trajectory whose instance_id is in this set is excluded,
   * and an overlap is asserted against — training on eval instances is fake
   * lift, the exact contamination we debunk elsewhere. Required (may be []).
   */
  evalHoldout: string[];
  /**
   * Max token budget per trajectory (rough word/char heuristic — see
   * `estimateTokens`). Trajectories over budget are DROPPED (or truncated when
   * `truncateOverLength` is set) and REPORTED — never silently lost. Targets a
   * 7-14B context window. Default 28000 (headroom under a 32k window).
   */
  maxTokens?: number;
  /**
   * When true, over-length trajectories are TRUNCATED (oldest tool round-trips
   * dropped, keeping system+issue+final) instead of dropped entirely. The drop
   * is still reported. Default false (drop, the safe default).
   */
  truncateOverLength?: boolean;
  /**
   * THE REWARD-HACKING FILTER (Ornith-1.0 borrow). When true (the DEFAULT), a
   * deterministic monitor runs over each trajectory and DROPS any that read a
   * withheld gold/test path, modified the verification harness, or escaped the
   * sandbox — an archived "success" that secretly reward-hacked would teach the
   * model to reward-hack. This is the training-data analog of the conformance
   * firewall. Set false ONLY for debugging; the count is always reported.
   */
  dropRewardHacked?: boolean;
}

/** What the exporter produced + an honest accounting of what it dropped. */
export interface ExportResult {
  sft: SftRow[];
  dpo: DpoRow[];
  report: ExportReport;
}

export interface ExportReport {
  totalTrajectories: number;
  /** Excluded because their instance_id is in the eval holdout (contamination guard). */
  excludedByHoldout: number;
  /** Dropped because over the token budget (the long-context filter). */
  droppedOverLength: number;
  /** Truncated to fit the token budget (only when truncateOverLength). */
  truncatedOverLength: number;
  /** Dropped by the reward-hacking monitor (gold-read / verification-tamper / sandbox-escape). */
  droppedRewardHacked: number;
  sftRows: number;
  dpoRows: number;
  /** Per-instance ids that ended up in the SFT set (for an audit trail). */
  sftInstanceIds: string[];
  /** Per-instance ids that ended up in the DPO set. */
  dpoInstanceIds: string[];
  /** Human-readable notes (e.g. which trajectories were dropped + why). */
  notes: string[];
}
