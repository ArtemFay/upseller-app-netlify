/**
 * GAS template tag engine.
 * Replaces <?= expr ?> (html-escaped) and <?!= expr ?> (raw) in HTML files.
 *
 * Only evaluates safe expressions from a known whitelist to avoid eval().
 */

/**
 * Process a GAS-style HTML template.
 * @param {string} html — raw HTML content with <?= ?> / <?!= ?> tags
 * @param {object} vars — { payload, context } objects injected into template scope
 * @returns {string} processed HTML
 */
function processTemplate(html, vars) {
  const { payload, context } = vars;

  // <?!= expr ?> — raw output (unescaped)
  html = html.replace(/<\?!=\s*([\s\S]*?)\s*\?>/g, (_, expr) => {
    return evaluateExpr(expr.trim(), payload, context);
  });

  // <?= expr ?> — html-escaped output
  html = html.replace(/<\?=\s*([\s\S]*?)\s*\?>/g, (_, expr) => {
    return escapeHtml(evaluateExpr(expr.trim(), payload, context));
  });

  return html;
}

/**
 * Evaluate a known GAS template expression.
 * Supports only the patterns actually used in the project.
 */
function evaluateExpr(expr, payload, context) {
  // JSON.stringify(payload)
  if (expr === 'JSON.stringify(payload)') {
    return JSON.stringify(payload || {});
  }

  // JSON.stringify(context)
  if (expr === 'JSON.stringify(context)') {
    return JSON.stringify(context || {});
  }

  // JSON.stringify(typeof context === 'undefined' ? { isWebApp: false, returnUrl: '' } : context)
  if (expr.includes('typeof context')) {
    return JSON.stringify(context || { isWebApp: false, returnUrl: '' });
  }

  // context.* lookups
  if (expr.startsWith('context.')) {
    const key = expr.slice('context.'.length);
    return String((context && context[key]) || '');
  }

  // payload.* lookups (future-proof)
  if (expr.startsWith('payload.')) {
    const key = expr.slice('payload.'.length);
    return String((payload && payload[key]) || '');
  }

  return `<!-- unknown template expr: ${expr} -->`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { processTemplate };
