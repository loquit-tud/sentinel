/**
 * Shared utility functions for badge/card rendering.
 * Consolidates barColor(), escapeHtml(), escapeXml() to avoid duplication.
 */

/**
 * Maps a 0-100 score to a risk color.
 * Used in bar charts and mini-gauges across badge renderers.
 */
export function barColor(value: number): string {
  if (value >= 70) return '#22c55e';  // green
  if (value >= 40) return '#eab308';  // yellow
  if (value >= 10) return '#ef4444';  // red
  return '#991b1b';                   // dark red
}

/**
 * Escapes XML/SVG special characters.
 * Used in SVG attribute values and text content.
 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Escapes HTML special characters.
 * Used in HTML embed widget and template content.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
