export type { ProactiveSuggestion, ConflictPair, PatternDetection, ProjectProgress, TfidfVector, SuggestionType, SuggestionPriority } from "./types.js";

export { detectConflict, scanForConflicts, formatConflictResults, resolveConflict } from "./conflict.js";
export type { ConflictResolution } from "./conflict.js";

export {
  checkAfterMemoryAdd,
  checkAfterGuidePractice,
  checkAfterMemoryRead,
  runFullAnalysis,
  formatSuggestions,
} from "./proactive.js";

export {
  calculateQualityScore,
  qualityScoreReasons,
  isLowQuality,
  QUALITY_SUGGESTION_THRESHOLD,
} from "./scoring.js";

export {
  getProjectAnalytics,
  getAllProjectsAnalytics,
  formatProjectProgress,
} from "./session-analytics.js";

export {
  buildVectors,
  findSemanticSimilar,
  findSemanticSimilarPairs,
  semanticSearch,
} from "./semantic.js";

export {
  computeSelfConsistency,
  scanOutcomeConsistency,
  outcomeConsistencySuggestions,
} from "./consistency.js";
export type { ConsistencyResult, ConsistencyVerdict } from "./consistency.js";

export {
  reciprocalRankFusion,
  mmrRerank,
  hybridSearch,
} from "./hybrid.js";
export type { HybridOptions, HybridResult } from "./hybrid.js";

export { buildVectorsCached } from "./vector-cache.js";
