import type { Page } from 'playwright';
import { collectTokens,splitRules } from '../third-party/ai-site-collectors.mjs';
export { splitRules };
export async function tokens(page:Page):Promise<Record<string,unknown>> {
  const result=await collectTokens(page);
  // Modern CSSStyleRule exposes cssRules for nesting. The upstream recursive walk
  // consequently skips :root declarations; collect measured computed variables here.
  const rootVariables=await page.evaluate(()=>{
    const css=getComputedStyle(document.documentElement);
    return Object.fromEntries(Array.from(css).filter(key=>key.startsWith('--')).map(key=>[key,css.getPropertyValue(key).trim()]));
  });
  return {...result,cssVariables:{...result.cssVariables,...rootVariables},cssVariableProvenance:'getComputedStyle(document.documentElement), adapter correction for CSS nesting'};
}
