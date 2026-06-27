// SPDX-License-Identifier: MIT
//
// @metaharness/weight-eft — public API.
//
// Evolutionary fine-tuning: distill Darwin's archival success into the open
// cheap tier via LoRA so the cost-cascade escalates to a frontier model less
// often. Cost-Pareto axis, not the frontier ceiling. See ADR-198.

export type {
  ChatMessage,
  ToolCall,
  PolicyTier,
  DarwinTrajectory,
  SftRow,
  DpoRow,
  ExportOptions,
  ExportResult,
  ExportReport,
} from './types.js';

export {
  exportTrainingData,
  assertTrainEvalDisjoint,
  estimateTokens,
  sftToJsonl,
  dpoToJsonl,
} from './export.js';

export type {
  BaseModelSpec,
  TrainStage,
  LoraConfig,
  TrainConfig,
  TrainRunOptions,
  TrainRunResult,
  TrainingPlan,
} from './train.js';

export {
  DEFAULT_LORA,
  defaultDetectGpu,
  assertTunableSize,
  sftConfig,
  dpoConfig,
  buildCommand,
  buildPlan,
  runTraining,
  twoStagePlan,
  adaptSftForRunner,
  adaptDpoForRunner,
} from './train.js';

export type { WeightAdapterGene } from './genome.js';

export {
  BASE_ADAPTER,
  WEIGHT_ADAPTERS,
  normalizeWeightAdapter,
  weightAdapterSuffix,
  weightAdapterFlags,
  usesAdapter,
} from './genome.js';

export type {
  CascadeOutcome,
  CascadeSummary,
  CostParetoDelta,
} from './eval.js';

export { summarizeCascade, costParetoDelta } from './eval.js';

export type { RewardHackKind, RewardHackFinding } from './reward-hack.js';

export { detectRewardHack, isRewardHacked } from './reward-hack.js';
