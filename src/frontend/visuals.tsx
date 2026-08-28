import type { ThemeId } from "./theme";

export type IconName =
  | "home"
  | "folder"
  | "library"
  | "system"
  | "upload"
  | "arrow"
  | "check"
  | "warning"
  | "chevron"
  | "file"
  | "refresh"
  | "palette"
  | "edit"
  | "expand"
  | "collapse"
  | "search"
  | "close";

function IconPaths({ name }: { name: IconName }) {
  if (name === "home") {
    return <><path d="M4 10.5 12 4l8 6.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M9 20v-6h6v6"/></>;
  }
  if (name === "folder") {
    return <><path d="M3.5 7.5h6l2-2h9v13h-17z"/><path d="M3.5 9h17"/></>;
  }
  if (name === "library") {
    return <><path d="M5 4v16M10 4v16M15 5l3-1 3 15-3 .7z"/><path d="M3 20h19"/></>;
  }
  if (name === "system") {
    return <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A8 8 0 0 0 15 6l-.3-2.6h-4L10.4 6a8 8 0 0 0-1.6 1l-2.3-1-2 3.4L6.6 11a7 7 0 0 0 0 2l-2.1 1.5 2 3.4 2.3-1a8 8 0 0 0 1.6 1l.3 2.6h4l.3-2.6a8 8 0 0 0 1.6-1l2.3 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z"/></>;
  }
  if (name === "upload") {
    return <><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M5 14v5h14v-5"/></>;
  }
  if (name === "arrow") {
    return <><path d="M5 12h13m-5-5 5 5-5 5"/></>;
  }
  if (name === "check") {
    return <path d="m5 12 4 4L19 6"/>;
  }
  if (name === "warning") {
    return <><path d="m12 3 9 17H3z"/><path d="M12 9v5m0 3h.01"/></>;
  }
  if (name === "chevron") {
    return <path d="m9 6 6 6-6 6"/>;
  }
  if (name === "file") {
    return <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h5"/></>;
  }
  if (name === "refresh") {
    return <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M18 9a7 7 0 0 0-12-2l-2 5M6 15a7 7 0 0 0 12 2l2-5"/></>;
  }
  if (name === "palette") {
    return <><path d="M12 3a9 9 0 0 0 0 18h1.2a1.8 1.8 0 0 0 1.4-2.9 1.8 1.8 0 0 1 1.4-2.9h2A3 3 0 0 0 21 12a9 9 0 0 0-9-9z"/><circle cx="8" cy="9" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/></>;
  }
  if (name === "expand") {
    return <><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/><path d="m4 4 6 6M20 4l-6 6M4 20l6-6M20 20l-6-6"/></>;
  }
  if (name === "collapse") {
    return <><path d="M9 10H4M9 10V5M15 10h5M15 10V5M9 14H4M9 14v5M15 14h5M15 14v5"/></>;
  }
  if (name === "search") {
    return <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></>;
  }
  if (name === "close") {
    return <path d="m6 6 12 12M18 6 6 18"/>;
  }
  return <><path d="M4 19.5V16l10.8-10.8 4 4L8 20H4z"/><path d="m13.5 6.5 4 4"/></>;
}

export function Icon({ name }: { name: IconName }) {
  return (
    <span className="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24"><IconPaths name={name}/></svg>
    </span>
  );
}

export function ThemeBrandMark({ theme }: { theme: ThemeId }) {
  if (theme === "ticket") return <svg viewBox="0 0 32 32" className="brand-svg" aria-hidden="true"><rect x="3" y="4" width="26" height="24" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8"/><line x1="11" y1="4" x2="11" y2="28" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2"/><path d="M15 16l8-5v2.5l-5 3.5 5 3.5v2.5z" fill="currentColor"/><circle cx="7" cy="16" r="2" fill="currentColor"/></svg>;
  if (theme === "proof") return <svg viewBox="0 0 32 32" className="brand-svg" aria-hidden="true"><circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="1.6"/><circle cx="16" cy="16" r="6" fill="none" stroke="currentColor" strokeWidth="1.2"/><line x1="16" y1="1" x2="16" y2="31" stroke="currentColor" strokeWidth="1.6"/><line x1="1" y1="16" x2="31" y2="16" stroke="currentColor" strokeWidth="1.6"/><rect x="13.5" y="13.5" width="5" height="5" fill="currentColor"/></svg>;
  if (theme === "fold") return <svg viewBox="0 0 32 32" className="brand-svg" aria-hidden="true"><polygon points="16,3 28,10 28,22 16,29 4,22 4,10" fill="none" stroke="currentColor" strokeWidth="1.6"/><line x1="16" y1="3" x2="16" y2="29" stroke="currentColor" strokeWidth="1.2"/><line x1="4" y1="10" x2="28" y2="22" stroke="currentColor" strokeWidth="1"/><line x1="28" y1="10" x2="4" y2="22" stroke="currentColor" strokeWidth="1"/><polygon points="16,3 28,10 16,16 4,10" fill="currentColor" fillOpacity="0.3"/><polygon points="16,16 28,22 16,29" fill="currentColor" fillOpacity="0.45"/></svg>;
  if (theme === "strata") return <svg viewBox="0 0 32 32" className="brand-svg" aria-hidden="true"><rect x="4" y="5" width="24" height="22" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6"/><line x1="4" y1="11" x2="28" y2="11" stroke="currentColor" strokeWidth="1.2"/><line x1="4" y1="17" x2="28" y2="17" stroke="currentColor" strokeWidth="1.2"/><line x1="4" y1="22" x2="28" y2="22" stroke="currentColor" strokeWidth="1.2"/><path d="M16 2v28M12 7l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><circle cx="16" cy="17" r="2.5" fill="currentColor"/></svg>;
  if (theme === "signal") return <svg viewBox="0 0 32 32" className="brand-svg" aria-hidden="true"><rect x="3" y="6" width="26" height="20" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6"/><circle cx="10" cy="16" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5"/><circle cx="10" cy="16" r="1.5" fill="currentColor"/><circle cx="22" cy="16" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5"/><circle cx="22" cy="16" r="1.5" fill="currentColor"/><path d="M10 20.5h12" stroke="currentColor" strokeWidth="1.4"/><circle cx="16" cy="11" r="1.2" fill="currentColor"/></svg>;
  if (theme === "celadon") return <svg viewBox="0 0 32 32" className="brand-svg" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M16 3c-4 5-6 8-6 13a6 6 0 0 0 12 0c0-5-2-8-6-13z" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M11 14l5 4 5-3M16 18v7M13 21h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><circle cx="16" cy="16" r="2" fill="currentColor"/></svg>;
  if (theme === "relay") return <svg viewBox="0 0 32 32" className="brand-svg" aria-hidden="true"><polygon points="6,3 26,3 29,6 29,26 26,29 6,29 3,26 3,6" fill="none" stroke="currentColor" strokeWidth="1.6"/><rect x="7" y="8" width="5" height="5" fill="currentColor"/><rect x="20" y="8" width="5" height="5" fill="currentColor"/><path d="M9.5 13v6h13v-6" fill="none" stroke="currentColor" strokeWidth="1.5"/><line x1="16" y1="19" x2="16" y2="25" stroke="currentColor" strokeWidth="1.8"/><circle cx="16" cy="25" r="1.8" fill="currentColor"/></svg>;
  if (theme === "inkwhite") return <svg viewBox="0 0 32 32" className="brand-svg" aria-hidden="true"><rect x="3.5" y="3.5" width="25" height="25" rx="1" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M8 8h16M16 8v16M10 13h12M10 18h12M9 23h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"/><rect x="6" y="6" width="3" height="3" fill="currentColor"/></svg>;
  return <svg viewBox="0 0 32 32" className="brand-svg" aria-hidden="true"><circle cx="16" cy="16" r="13.5" fill="none" stroke="currentColor" strokeWidth="1.8"/><circle cx="16" cy="16" r="8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2"/><circle cx="16" cy="16" r="3" fill="currentColor"/><path d="M16 1.5v4M16 26.5v4M1.5 16h4M26.5 16h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M6 6l3 3M23 23l3 3M6 26l3-3M23 9l3-3" stroke="currentColor" strokeWidth="1.2"/></svg>;
}

export function ThemeIntakeVisual({ theme }: { theme: ThemeId }) {
  if (theme === "ticket") return <div className="hero-visual-obj hero-ticket-obj" aria-hidden="true" title="复古航空登机凭证存根"><div className="ticket-stub-card"><div className="stub-header"><span>FLIGHT 2026</span><em>CN → EN</em></div><div className="stub-barcode">{Array.from({ length: 8 }, (_, index) => <i key={index}/>)}</div><div className="stub-badge"><span className="stub-seal"><Icon name="upload"/></span><strong>CHECK IN</strong></div></div><span className="hero-obj-caption">BOARDING PASS STUB</span></div>;
  if (theme === "proof") return <div className="hero-visual-obj hero-proof-obj" aria-hidden="true" title="CMYK 印刷套印准星靶盘"><div className="proof-register-target"><div className="cmyk-cross-vert"/><div className="cmyk-cross-horiz"/><div className="cmyk-ring ring-c"/><div className="cmyk-ring ring-m"/><div className="cmyk-ring ring-y"/><div className="cmyk-ring ring-k"><Icon name="upload"/></div></div><span className="hero-obj-caption">REGISTRATION TARGET</span></div>;
  if (theme === "fold") return <div className="hero-visual-obj hero-fold-obj" aria-hidden="true" title="等角折纸立体星图"><div className="fold-polyhedron"><div className="poly-facet facet-top"/><div className="poly-facet facet-left"/><div className="poly-facet facet-right"/><div className="poly-center-spark"><Icon name="upload"/></div></div><span className="hero-obj-caption">ISOMETRIC STAR ATLAS</span></div>;
  if (theme === "strata") return <div className="hero-visual-obj hero-strata-obj" aria-hidden="true" title="高精度等高线声纳层析球"><div className="strata-sonar-globe"><div className="sonar-grid-lat"/><div className="sonar-grid-lon"/><div className="sonar-contour-ring ring-1"/><div className="sonar-contour-ring ring-2"/><div className="sonar-sweep-radar"/><div className="sonar-core-depth"><Icon name="upload"/></div></div><span className="hero-obj-caption">BATHYMETRY RADAR</span></div>;
  if (theme === "signal") return <div className="hero-visual-obj hero-signal-obj" aria-hidden="true" title="广播级开盘磁带走带收录轮"><div className="signal-twin-reels"><div className="tape-spool spool-left"><div className="spool-hole h1"/><div className="spool-hole h2"/><div className="spool-hole h3"/></div><div className="tape-ribbon-bridge"><i/></div><div className="tape-spool spool-right"><div className="spool-hole h1"/><div className="spool-hole h2"/><div className="spool-hole h3"/><div className="spool-hub"><Icon name="upload"/></div></div></div><span className="hero-obj-caption">ANALOG MASTER REEL</span></div>;
  if (theme === "celadon") return <div className="hero-visual-obj hero-celadon-obj" aria-hidden="true" title="宋代汝窑青瓷雨青金缮釉盘"><div className="celadon-glazed-dish"><div className="kintsugi-gold-vein"/><div className="celadon-water-ring ring-inner"/><div className="celadon-water-ring ring-outer"/><div className="celadon-gem-drop"><Icon name="upload"/></div></div><span className="hero-obj-caption">RU KILN · 金缮天青</span></div>;
  if (theme === "relay") return <div className="hero-visual-obj hero-relay-obj" aria-hidden="true" title="工控 DIN 导轨端子与排灯模块"><div className="relay-module-box"><div className="module-screws"><i className="s-tl"/><i className="s-tr"/><i className="s-bl"/><i className="s-br"/></div><div className="module-led-matrix"><span className="m-led is-active"/><span className="m-led is-active"/><span className="m-led"/><span className="m-led is-active"/></div><div className="module-terminal-block"><Icon name="upload"/></div></div><span className="hero-obj-caption">DIN-RAIL BUS 24V</span></div>;
  if (theme === "inkwhite") return <div className="hero-visual-obj hero-inkwhite-obj" aria-hidden="true" title="古籍宣纸与朱砂落印方章"><div className="inkwhite-scroll-seal"><div className="ink-diffuse-wash"/><div className="cinnabar-square-stamp"><span>译</span><div className="stamp-icon"><Icon name="upload"/></div></div></div><span className="hero-obj-caption">宣纸朱砂 · 墨韵天成</span></div>;
  return <div className="hero-visual-obj hero-brass-obj" aria-hidden="true" title="黄铜机械擒纵游丝与齿牙"><div className="brass-escapement-ring"><div className="brass-outer-cogs">{Array.from({ length: 8 }, (_, index) => <i key={index}/>)}</div><div className="brass-hairspring"/><div className="brass-core-gem"><Icon name="upload"/></div></div><span className="hero-obj-caption">ESCAPEMENT NO. 01</span></div>;
}

export function ThemeVisualizer({ theme, playing = false }: { theme: ThemeId; playing?: boolean }) {
  const active = playing ? "is-playing" : "";
  if (theme === "ticket") return <div className={`visualizer-panel visualizer-ticket ${active}`} title="航空雷达扫描回波" aria-hidden="true"><div className="ticket-radar"><div className="radar-beam"/><div className="radar-blip"/></div><div className="visual-meta"><span>RADAR / ROUTE</span><label>084° HDG</label></div></div>;
  if (theme === "proof") return <div className={`visualizer-panel visualizer-proof ${active}`} title="CMYK 印刷四色套印色阶" aria-hidden="true"><div className="cmyk-bars"><div className="cmyk-col col-c"><span>C</span><i/></div><div className="cmyk-col col-m"><span>M</span><i/></div><div className="cmyk-col col-y"><span>Y</span><i/></div><div className="cmyk-col col-k"><span>K</span><i/></div></div><div className="visual-meta"><span>CMYK DENSITY</span><label>100% REG</label></div></div>;
  if (theme === "fold") return <div className={`visualizer-panel visualizer-fold ${active}`} title="折纸星图八面体脉冲" aria-hidden="true"><div className="fold-octa"><i/><i/><i/><i/></div><div className="visual-meta"><span>OCTA-STAR</span><label>3D MESH</label></div></div>;
  if (theme === "strata") return <div className={`visualizer-panel visualizer-strata ${active}`} title="声纳高程切片扫描" aria-hidden="true"><div className="strata-scanlines"><i/><i/><i/><i/></div><div className="visual-meta"><span>SONAR SLICE</span><label>-180m</label></div></div>;
  if (theme === "signal") return <div className={`visualizer-panel visualizer-signal ${active}`} title="开盘磁带与模拟双针 VU 表" aria-hidden="true"><div className="vu-meter"><div className="vu-scale"/><div className={`vu-needle ${active}`}/><label>CH-L</label></div><div className="vu-meter"><div className="vu-scale"/><div className={`vu-needle ${active}`}/><label>CH-R</label></div></div>;
  if (theme === "celadon") return <div className={`visualizer-panel visualizer-celadon ${active}`} title="宋瓷雨青冰裂水波纹" aria-hidden="true"><div className="celadon-ripples"><span className="rip rip-1"/><span className="rip rip-2"/></div><div className="visual-meta"><span>雨青谐振</span><label>CELADON</label></div></div>;
  if (theme === "relay") return <div className={`visualizer-panel visualizer-relay ${active}`} title="工控 DIN 导轨 LED 排灯" aria-hidden="true"><div className="relay-leds"><div className="led-bar"><i/><i/><i/><i/><i/></div><div className="led-bar"><i/><i/><i/><i/><i/></div></div><div className="visual-meta"><span>DIN-RAIL 24V</span><label>CHANNEL 01</label></div></div>;
  if (theme === "inkwhite") return <div className={`visualizer-panel visualizer-inkwhite ${active}`} title="水墨声律与宣纸墨滴涟漪" aria-hidden="true"><div className="ink-ripples"><span className="ink-dot"/><span className="ink-wave"/></div><div className="visual-meta"><span>墨韵声律</span><label>INK-WASH</label></div></div>;
  return <div className={`visualizer-panel visualizer-brass ${active}`} title="机械擒纵发条与双同心转子" aria-hidden="true"><div className="brass-gear-box"><div className="brass-gear"><i/><i/><i/><i/></div><div className="brass-balance"/></div><div className="visual-meta"><span>ESCAPEMENT</span><label>RPM 120</label></div></div>;
}
