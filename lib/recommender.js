'use strict';
/**
 * Recommendation engine — explainable, rule-based scoring.
 * Signals: same category, shared tags, popularity (normalized), recency.
 * Every suggestion carries human-readable reasons.
 */
const DAY = 24 * 60 * 60 * 1000;

function normalizeTagList(tool) { return Array.isArray(tool.tags) ? tool.tags : []; }
function sharedTags(a, b) {
  const set = new Set(normalizeTagList(b));
  return normalizeTagList(a).filter((t) => set.has(t));
}
function recencyFactor(createdAt) {
  if (!createdAt) return 0.25;
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / DAY;
  return Math.max(0, 1 - ageDays / 365) * 0.4 + 0.1;
}

function maxPopularity(tools) {
  return Math.max(1, ...tools.map((t) => t.popularity || 0));
}

/**
 * Score `candidate` against a `base` tool (same category / shared tags).
 * Returns { score, reasons }.
 */
function scoreAgainstBase(candidate, base, maxPop) {
  let score = 0;
  const reasons = [];
  if (candidate.category === base.category) { score += 5; reasons.push(`Same category as ${base.name}`); }
  const shared = sharedTags(candidate, base);
  if (shared.length) { score += 3 * shared.length; reasons.push(`Shares tags: ${shared.slice(0, 3).join(', ')}`); }
  score += 2 * ((candidate.popularity || 0) / maxPop);
  score += recencyFactor(candidate.created_at);
  return { score, reasons };
}

/** Related tools for a tool detail page. */
function related(tool, all, limit = 4) {
  const maxPop = maxPopularity(all);
  return all
    .filter((t) => t.id !== tool.id && t.status === 'published')
    .map((t) => ({ tool: t, ...scoreAgainstBase(t, tool, maxPop) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ tool: x.tool, reasons: x.reasons }));
}

/**
 * Personalized recommendations for a user, based on their most recent
 * favorite (primary signal) and recent views (secondary).
 * Returns { items: [{tool, reasons}], basis: string }.
 */
function forUser(userFavorites, recentViews, all, limit = 6) {
  const maxPop = maxPopularity(all);
  const base = userFavorites[0] || recentViews[0] || null;
  const seedIds = new Set([...(userFavorites || []), ...(recentViews || [])].map((t) => t.id));
  let basis = base ? `Because you saved ${base.name}` : `Based on tools you've viewed`;
  if (!base && recentViews && recentViews.length) basis = `Because you viewed ${recentViews[0].name}`;
  if (!base && (!recentViews || !recentViews.length)) basis = 'Popular right now';

  let scored = all
    .filter((t) => t.status === 'published' && !seedIds.has(t.id))
    .map((t) => {
      if (!base) return { tool: t, score: 2 * ((t.popularity || 0) / maxPop) + recencyFactor(t.created_at), reasons: [] };
      return { tool: t, ...scoreAgainstBase(t, base, maxPop) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ tool: x.tool, reasons: x.reasons.length ? x.reasons : (base ? [] : ['Popular right now']) }));

  if (!base) {
    scored = scored.map((x) => ({ tool: x.tool, reasons: ['Popular right now'] }));
  }
  return { items: scored, basis };
}

/** Category page: trending + new arrivals. */
function categoryHighlights(tools, limit = 4) {
  const sorted = [...tools].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  const newest = [...tools].sort((a, b) => (b.created_at < a.created_at ? -1 : 1));
  return { trending: sorted.slice(0, limit), newest: newest.slice(0, limit) };
}

module.exports = { related, forUser, categoryHighlights, sharedTags };
