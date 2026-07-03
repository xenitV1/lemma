import type { MemoryFragment } from "../types.js";
import type { Guide } from "../types.js";
import type { ProactiveSuggestion, PatternDetection } from "./types.js";
import { logger } from "../logger.js";
import { isLowQuality, qualityScoreReasons } from "./scoring.js";

export function checkAfterMemoryAdd(
  fragment: MemoryFragment,
  allFragments: MemoryFragment[],
  allGuides: Guide[]
): ProactiveSuggestion[] {
  const suggestions: ProactiveSuggestion[] = [];

  const patternHits = detectRecurringPatterns(fragment, allFragments);
  for (const pattern of patternHits) {
    if (pattern.occurrences >= 3) {
      const existingGuide = allGuides.find(g =>
        pattern.suggested_guide && g.guide === pattern.suggested_guide.toLowerCase()
      );
      if (!existingGuide) {
        suggestions.push({
          type: "distill",
          priority: pattern.occurrences >= 5 ? "high" : "medium",
          message: `Pattern detected: "${pattern.pattern_text}" appears ${pattern.occurrences} times across memories. Consider distilling into a guide.`,
          suggested_action: `guide_distill with guide="${pattern.suggested_guide || "unnamed-pattern"}" category="pattern"`,
        });
      }
    }
  }

  const sameTypeCount = allFragments.filter(f =>
    f.type === fragment.type && f.project === fragment.project
  ).length;
  if (sameTypeCount >= 10 && fragment.type === "fact") {
    suggestions.push({
      type: "refine",
      priority: "low",
      message: `${sameTypeCount} ${fragment.type} fragments in ${fragment.project || "global"}. Consider reviewing for consolidation or reclassification.`,
    });
  }

  const distillCandidates = allFragments.filter(f => f.distill_candidate);
  if (distillCandidates.length >= 3) {
    suggestions.push({
      type: "distill",
      priority: "medium",
      message: `${distillCandidates.length} memories marked as distill candidates. Consider promoting them to guides.`,
    });
  }

  logger.flow("proactive", "after_add", { suggestions: suggestions.length });
  return suggestions;
}

export function checkAfterGuidePractice(
  guide: Guide,
  allGuides: Guide[]
): ProactiveSuggestion[] {
  const suggestions: ProactiveSuggestion[] = [];

  const totalAttempts = (guide.success_count || 0) + (guide.failure_count || 0);
  if (totalAttempts >= 5) {
    const successRate = (guide.success_count || 0) / totalAttempts;
    if (successRate < 0.3) {
      suggestions.push({
        type: "refine",
        priority: "high",
        message: `Guide "${guide.guide}" has ${Math.round(successRate * 100)}% success rate (${guide.success_count}/${totalAttempts}). Consider refining its description or marking as deprecated.`,
        suggested_action: `guide_update with guide="${guide.guide}" deprecated=true or update description`,
      });
    }
  }

  if (!guide.description && guide.usage_count >= 3) {
    suggestions.push({
      type: "refine",
      priority: "medium",
      message: `Guide "${guide.guide}" used ${guide.usage_count}x but has no description. Add a protocol to improve effectiveness.`,
      suggested_action: `guide_update with guide="${guide.guide}" description="..."`,
    });
  }

  if (guide.learnings.length >= 5 && !guide.description) {
    suggestions.push({
      type: "refine",
      priority: "medium",
      message: `Guide "${guide.guide}" has ${guide.learnings.length} learnings but no description. Distill learnings into a structured protocol.`,
    });
  }

  if (guide.contexts.length >= 3 && guide.usage_count >= 4) {
    const similarGuides = findMergeCandidates(guide, allGuides);
    for (const candidate of similarGuides) {
      suggestions.push({
        type: "merge",
        priority: "low",
        message: `Guides "${guide.guide}" and "${candidate.guide}" share ${candidate.sharedContexts} contexts. Consider merging.`,
        suggested_action: `guide_merge with guides=["${guide.guide}", "${candidate.guide}"] guide="..."`,
      });
    }
  }

  logger.flow("proactive", "after_practice", { guide: guide.guide, suggestions: suggestions.length });
  return suggestions;
}

export function checkAfterMemoryRead(
  readFragments: MemoryFragment[],
  allFragments: MemoryFragment[]
): ProactiveSuggestion[] {
  const suggestions: ProactiveSuggestion[] = [];

  if (readFragments.length >= 2) {
    const unreferenced: string[] = [];
    for (let i = 0; i < readFragments.length; i++) {
      for (let j = i + 1; j < readFragments.length; j++) {
        const a = readFragments[i];
        const b = readFragments[j];
        const aRels = (a.relations || []).map(r => r.id);
        const bRels = (b.relations || []).map(r => r.id);
        if (!aRels.includes(b.id) && !bRels.includes(a.id)) {
          unreferenced.push(`${a.id} ↔ ${b.id}`);
        }
      }
    }
    if (unreferenced.length >= 2) {
      suggestions.push({
        type: "relate",
        priority: "low",
        message: `${unreferenced.length} pairs of co-read memories have no relations. Consider linking related ones.`,
      });
    }
  }

  const lowConfRead = readFragments.filter(f => f.confidence < 0.4);
  if (lowConfRead.length > 0) {
    suggestions.push({
      type: "archive",
      priority: "low",
      message: `${lowConfRead.length} of ${readFragments.length} read fragments have low confidence (<0.4). Consider memory_feedback to strengthen or memory_forget to prune.`,
    });
  }

  const hotCandidates = readFragments.filter(f =>
    (f.type === "pattern" || f.type === "lesson") &&
    f.accessed >= 5 &&
    f.distill_candidate !== false &&
    !(f.related_guides && f.related_guides.length > 0)
  );
  for (const frag of hotCandidates) {
    suggestions.push({
      type: "distill",
      priority: frag.accessed >= 10 ? "high" : "medium",
      message: `Fragment [${frag.id}] "${frag.title}" is a ${frag.type} accessed ${frag.accessed}x but has no guide. This is frequently reused knowledge — distill it into a reusable skill.`,
      suggested_action: `guide_distill with memory_id="${frag.id}" guide="${frag.title.split(/\s+/).slice(0, 2).join("-").toLowerCase()}"`,
    });
  }

  logger.flow("proactive", "after_read", { suggestions: suggestions.length });
  return suggestions;
}

export function runFullAnalysis(
  allFragments: MemoryFragment[],
  allGuides: Guide[]
): ProactiveSuggestion[] {
  const suggestions: ProactiveSuggestion[] = [];

  const staleCount = allFragments.filter(f => f.confidence < 0.2).length;
  if (staleCount > 0) {
    suggestions.push({
      type: "archive",
      priority: staleCount > 10 ? "high" : "medium",
      message: `${staleCount} memories have very low confidence (<0.2). Consider cleanup with memory_forget or memory_feedback.`,
    });
  }

  const orphanCount = allFragments.filter(f =>
    (f.relations || []).length === 0 && f.accessed < 2
  ).length;
  if (orphanCount > allFragments.length * 0.5) {
    suggestions.push({
      type: "relate",
      priority: "medium",
      message: `${orphanCount} of ${allFragments.length} memories are isolated (no relations, rarely accessed). Consider reading and linking them.`,
    });
  }

  const deprecatedGuides = allGuides.filter(g => g.deprecated);
  if (deprecatedGuides.length > 0) {
    suggestions.push({
      type: "archive",
      priority: "low",
      message: `${deprecatedGuides.length} deprecated guide(s): ${deprecatedGuides.map(g => g.guide).join(", ")}. Consider guide_forget to clean up.`,
    });
  }

  const unpracticedGuides = allGuides.filter(g => g.usage_count >= 3 && g.learnings.length === 0);
  if (unpracticedGuides.length > 0) {
    suggestions.push({
      type: "refine",
      priority: "medium",
      message: `${unpracticedGuides.length} guide(s) used ${unpracticedGuides.length > 0 ? "3+" : ""} times without learnings: ${unpracticedGuides.slice(0, 3).map(g => g.guide).join(", ")}. Add learnings via guide_practice.`,
    });
  }

  const hotDistill = allFragments.filter(f =>
    (f.type === "pattern" || f.type === "lesson") &&
    f.accessed >= 5 &&
    !(f.related_guides && f.related_guides.length > 0)
  );
  if (hotDistill.length > 0) {
    suggestions.push({
      type: "distill",
      priority: hotDistill.some(f => f.accessed >= 10) ? "high" : "medium",
      message: `${hotDistill.length} frequently accessed pattern(s)/lesson(s) without guides: ${hotDistill.slice(0, 3).map(f => `"${f.title}" (${f.accessed}x)`).join(", ")}. These are reused knowledge — distill into guides.`,
      suggested_action: `guide_distill for each hot fragment`,
    });
  }

  const lowQuality = allFragments.filter(isLowQuality);
  if (lowQuality.length > 0) {
    const examples = lowQuality
      .slice(0, 3)
      .map(f => `[${f.id}] "${f.title}" (${qualityScoreReasons(f).join(", ")})`)
      .join("; ");
    suggestions.push({
      type: "refine",
      priority: lowQuality.length > 5 ? "high" : "medium",
      message: `${lowQuality.length} memory(ies) score below the quality threshold (poor feedback/recall track record): ${examples}. Refine or prune them.`,
      suggested_action: `memory_update / memory_feedback / memory_forget on the weakest fragments`,
    });
  }

  logger.flow("proactive", "full_analysis", { suggestions: suggestions.length });
  return suggestions;
}

function detectRecurringPatterns(
  newFragment: MemoryFragment,
  allFragments: MemoryFragment[]
): PatternDetection[] {
  const patterns: PatternDetection[] = [];
  const projectFrags = allFragments.filter(f => f.project === newFragment.project);

  const keyPhrases = extractKeyPhrases(newFragment.fragment);
  for (const phrase of keyPhrases) {
    const matching = projectFrags.filter(f =>
      f.fragment.toLowerCase().includes(phrase.toLowerCase())
    );
    if (matching.length >= 2) {
      patterns.push({
        pattern_text: phrase,
        occurrences: matching.length + 1,
        memory_ids: [...matching.map(m => m.id), newFragment.id],
        suggested_guide: phrase.split(/\s+/).slice(0, 2).join("-"),
        suggested_category: guessCategory(newFragment),
      });
    }
  }

  return patterns.sort((a, b) => b.occurrences - a.occurrences);
}

function extractKeyPhrases(text: string): string[] {
  const phrases: string[] = [];
  const sentences = text.split(/[.!?]\s+/);

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length < 10 || trimmed.length > 80) continue;

    const hasTechnicalTerm = /\b(use|avoid|prefer|recommend|always|never|pattern|approach|implement|error|bug|fix|config|setup|install)\b/i.test(trimmed);
    if (hasTechnicalTerm) {
      phrases.push(trimmed);
    }
  }

  return phrases;
}

function guessCategory(fragment: MemoryFragment): string {
  const text = fragment.fragment.toLowerCase();
  if (/\b(react|vue|angular|component|hook|render|dom|css|html)\b/.test(text)) return "web-frontend";
  if (/\b(api|server|database|endpoint|auth|middleware|rest|graphql)\b/.test(text)) return "web-backend";
  if (/\b(test|spec|jest|vitest|mocha|coverage|unit|integration)\b/.test(text)) return "testing";
  if (/\b(git|deploy|ci|cd|docker|kubernetes|terraform)\b/.test(text)) return "devops";
  if (/\b(typescript|python|rust|go|java|ruby)\b/.test(text)) return "programming-language";
  if (/\b(sql|postgres|mysql|mongodb|redis|sqlite)\b/.test(text)) return "data-storage";
  return "dev-tool";
}

function findMergeCandidates(
  guide: Guide,
  allGuides: Guide[]
): Array<{ guide: string; sharedContexts: number }> {
  const candidates: Array<{ guide: string; sharedContexts: number }> = [];
  const guideContexts = new Set(guide.contexts.map(c => c.toLowerCase()));

  for (const other of allGuides) {
    if (other.guide === guide.guide) continue;
    if (other.category !== guide.category) continue;

    const otherContexts = new Set(other.contexts.map(c => c.toLowerCase()));
    let shared = 0;
    for (const ctx of guideContexts) {
      if (otherContexts.has(ctx)) shared++;
    }

    if (shared >= 2) {
      candidates.push({ guide: other.guide, sharedContexts: shared });
    }
  }

  return candidates.sort((a, b) => b.sharedContexts - a.sharedContexts).slice(0, 2);
}

export function formatSuggestions(suggestions: ProactiveSuggestion[]): string {
  if (suggestions.length === 0) return "";

  const high = suggestions.filter(s => s.priority === "high");
  const medium = suggestions.filter(s => s.priority === "medium");
  const low = suggestions.filter(s => s.priority === "low");

  let output = "\n--- SUGGESTIONS ---\n";

  for (const s of high) {
    output += `  [!] ${s.message}\n`;
    if (s.suggested_action) output += `      → ${s.suggested_action}\n`;
  }
  for (const s of medium) {
    output += `  [*] ${s.message}\n`;
    if (s.suggested_action) output += `      → ${s.suggested_action}\n`;
  }
  for (const s of low) {
    output += `  [ ] ${s.message}\n`;
  }

  output += "---\n";
  return output;
}
