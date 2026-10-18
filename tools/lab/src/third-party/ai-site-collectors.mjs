// Selected unmodified functions. Copyright (c) 2026 Mahanaicoach. MIT; see licenses/ai-site-cloner-LICENSE.
export async function collectTokens(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll("body *")].slice(0, 3000);
    const count = (map, key) => key && map.set(key, (map.get(key) || 0) + 1);
    const colors = new Map();
    const bgs = new Map();
    const families = new Map();
    const radii = new Map();
    const shadows = new Map();
    const fontSizes = new Map();
    // Which animations are actually used on the page, and on how many elements —
    // read in the same pass as the token counts: getComputedStyle forces a style
    // resolution per element, so one walk instead of two halves that cost.
    const animationsInUse = {};

    for (const el of els) {
      const cs = getComputedStyle(el);
      count(colors, cs.color);
      if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") count(bgs, cs.backgroundColor);
      count(families, cs.fontFamily);
      if (cs.borderRadius !== "0px") count(radii, cs.borderRadius);
      if (cs.boxShadow !== "none") count(shadows, cs.boxShadow);
      if (el.textContent?.trim()) count(fontSizes, `${cs.fontSize}/${cs.fontWeight}/${cs.lineHeight}`);
      if (cs.animationName && cs.animationName !== "none") {
        const key = `${cs.animationName} | ${cs.animationDuration} | ${cs.animationTimingFunction} | ${cs.animationIterationCount} | delay ${cs.animationDelay}`;
        animationsInUse[key] = (animationsInUse[key] || 0) + 1;
      }
    }
    const top = (map, n = 20) =>
      [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, uses]) => ({ value, uses }));

    // Typography of key elements
    const typo = {};
    for (const sel of ["h1", "h2", "h3", "h4", "p", "a", "button", "body"]) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      typo[sel] = {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        color: cs.color,
        textTransform: cs.textTransform,
      };
    }

    // :root custom properties + @keyframes bodies (same-origin stylesheets only).
    // Capturing keyframes matters: computed styles tell you `animation: slide-up-fade 1s`
    // but not what slide-up-fade DOES. Without the rule body a builder can only guess.
    const cssVars = {};
    const keyframes = {};
    const walkRules = (rules) => {
      for (const rule of rules) {
        if (rule.type === 7 || rule.constructor?.name === "CSSKeyframesRule") {
          const steps = {};
          for (const kf of rule.cssRules) steps[kf.keyText] = kf.style.cssText;
          keyframes[rule.name] = steps;
          continue;
        }
        if (rule.cssRules) {
          try {
            walkRules(rule.cssRules);
          } catch { /* ignore */ }
          continue;
        }
        if (rule.selectorText === ":root" || rule.selectorText === "html") {
          for (const prop of rule.style) {
            if (prop.startsWith("--")) cssVars[prop] = rule.style.getPropertyValue(prop).trim();
          }
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walkRules(sheet.cssRules);
      } catch {
        continue; // cross-origin sheet
      }
    }

    const fontLinks = [...document.querySelectorAll('link[rel="stylesheet"], link[rel="preload"][as="font"]')]
      .map((l) => l.href)
      .filter((h) => /fonts\.|font|\.woff/i.test(h));

    const htmlCs = getComputedStyle(document.documentElement);
    const bodyCs = getComputedStyle(document.body);
    const globalBehaviors = {
      smoothScrollLib: document.querySelector(".lenis, [data-lenis], .locomotive-scroll, [data-scroll-container]")
        ? "detected (Lenis or Locomotive — inspect manually)"
        : null,
      scrollBehavior: htmlCs.scrollBehavior,
      scrollSnapType: htmlCs.scrollSnapType !== "none" ? htmlCs.scrollSnapType : bodyCs.scrollSnapType !== "none" ? bodyCs.scrollSnapType : null,
      bodyBackground: bodyCs.backgroundColor,
      hasFixedHeader: !!document.querySelector("header, nav") &&
        ["fixed", "sticky"].includes(getComputedStyle(document.querySelector("header, nav")).position),
    };

    return {
      colors: top(colors),
      backgrounds: top(bgs),
      fontFamilies: top(families, 10),
      typography: typo,
      fontSizeCombos: top(fontSizes, 25),
      borderRadii: top(radii, 10),
      boxShadows: top(shadows, 10),
      cssVariables: cssVars,
      keyframes,
      animationsInUse,
      fontLinks,
      globalBehaviors,
    };
  });
}

// ---------------------------------------------------------------------------
// Stylesheet rules (hover/focus states, breakpoints, keyframe names)
// ---------------------------------------------------------------------------

// Light brace-matching parser: CSS is regular enough at this level, and this
// avoids taking a dependency just to find hover rules.
export function splitRules(css) {
  const out = [];
  let depth = 0, buf = "", atRule = null, atBuf = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      depth++;
      if (depth === 1) {
        const head = buf.trim();
        buf = "";
        if (head.startsWith("@media") || head.startsWith("@supports") || head.startsWith("@layer") || head.startsWith("@container")) {
          atRule = head;
          atBuf = "";
          continue;
        }
        out.push({ selector: head, body: "", _open: true });
        continue;
      }
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        if (atRule) {
          for (const inner of splitRules(atBuf)) out.push({ ...inner, media: atRule });
          atRule = null;
          atBuf = "";
        } else {
          const last = out[out.length - 1];
          if (last?._open) {
            last.body = buf.trim();
            delete last._open;
          }
          buf = "";
        }
        continue;
      }
    }
    if (atRule && depth >= 1) atBuf += ch;
    else buf += ch;
  }
  return out.filter((r) => r.selector && !r.selector.startsWith("@"));
}
