import { useEffect, useLayoutEffect, useState } from 'preact/hooks';

/** Whether a media query matches, kept up to date. */
export function useMedia(query) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/**
 * The width of an element, kept up to date: pass the returned ref callback as its `ref`. Measured
 * before the browser paints, so a layout that depends on it doesn't jump; `fallback` until then.
 */
export function useWidth(fallback) {
  const [el, setEl] = useState(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}
