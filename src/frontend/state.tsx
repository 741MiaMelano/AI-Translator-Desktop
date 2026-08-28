import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  AsrCapabilityStatusResponse,
  AsrDeviceStatusResponse,
  CapabilityReadinessResponse,
  DesktopIpcResult,
  ProjectIndexSummary,
  WindowControlAction,
} from "../contracts/desktop-api";
import type { Project } from "../domain/workspace";
import { localizeIpcErrorText } from "../i18n/errors";
import { useWorkspace } from "../state/WorkspaceContext";
import {
  desktopGetAsrCapabilityStatus,
  desktopGetAsrDeviceStatus,
  desktopGetCapabilityReadiness,
  desktopListRecentProjects,
  desktopOpenProject,
  desktopWindowControl,
  isDesktopRuntime,
} from "../services/desktop-client";
import type { KeymapId } from "./shortcuts";
import { disposeThemeSound, playThemeSound, type UiSound } from "./sound";
import { isThemeId, THEME_BY_ID, type ThemeId } from "./theme";

export interface ReadState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

interface Notice {
  tone: "status" | "error";
  message: string;
}

interface FrontendContextValue {
  desktopAvailable: boolean;
  projects: ReadState<ProjectIndexSummary[]>;
  readiness: ReadState<CapabilityReadinessResponse>;
  asr: ReadState<AsrCapabilityStatusResponse>;
  asrDevice: ReadState<AsrDeviceStatusResponse>;
  activeProject: Project | null;
  openingProjectId: string | null;
  theme: ThemeId;
  soundEnabled: boolean;
  effectsEnabled: boolean;
  reducedMotionForced: boolean;
  reducedMotion: boolean;
  effectsActive: boolean;
  compactRail: boolean;
  setRailAutoCompact: (value: boolean) => void;
  keymap: KeymapId;
  setKeymap: (keymap: KeymapId) => void;
  density: Density;
  toggleDensity: () => void;
  densityReveal: boolean;
  dismissDensityReveal: () => void;
  notice: Notice | null;
  refresh: () => Promise<void>;
  openProject: (projectId: string) => Promise<boolean>;
  play: (sound: UiSound) => void;
  setTheme: (theme: ThemeId) => void;
  toggleSound: () => void;
  toggleEffects: () => void;
  toggleReducedMotion: () => void;
  toggleRail: () => void;
  controlWindow: (action: WindowControlAction) => Promise<void>;
}

const FrontendContext = createContext<FrontendContextValue | null>(null);

const STORAGE = {
  theme: "ai_translator_theme",
  sound: "ai_translator_sound",
  effects: "ai_translator_effects",
  reducedMotion: "ai_translator_reduced_motion",
  compactRail: "ai_translator_compact_rail",
  keymap: "ai_translator_keymap",
  density: "ai_translator_density",
} as const;

/** 密度开关只控制技术读数的显示密度，绝不隐藏任何"门"。 */
export type Density = "simple" | "pro";

function storedTheme(): ThemeId {
  const value = localStorage.getItem(STORAGE.theme);
  return isThemeId(value) ? value : "brass";
}

function storedKeymap(): KeymapId {
  const value = localStorage.getItem(STORAGE.keymap);
  return value === "nle" || value === "aegisub" ? value : "modern";
}

function emptyReadState<T>(): ReadState<T> {
  return { data: null, loading: true, error: null };
}

function resultState<T>(result: DesktopIpcResult<T>): ReadState<T> {
  return result.ok
    ? { data: result.data, loading: false, error: null }
    : { data: null, loading: false, error: localizeIpcErrorText(result.error) };
}

function rejectedCallText(error: unknown) {
  return error instanceof Error && error.message
    ? `桌面服务调用失败：${error.message}`
    : "桌面服务调用失败，请重新检测。";
}

export function FrontendProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const desktopAvailable = isDesktopRuntime();
  const [projects, setProjects] = useState<ReadState<ProjectIndexSummary[]>>(emptyReadState);
  const [readiness, setReadiness] = useState<ReadState<CapabilityReadinessResponse>>(emptyReadState);
  const [asr, setAsr] = useState<ReadState<AsrCapabilityStatusResponse>>(emptyReadState);
  const [asrDevice, setAsrDevice] = useState<ReadState<AsrDeviceStatusResponse>>(emptyReadState);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [theme, setThemeState] = useState<ThemeId>(storedTheme);
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem(STORAGE.sound) === "true");
  const [effectsEnabled, setEffectsEnabled] = useState(() => localStorage.getItem(STORAGE.effects) !== "false");
  const [reducedMotionForced, setReducedMotionForced] = useState(() => localStorage.getItem(STORAGE.reducedMotion) === "true");
  const [systemReducedMotion, setSystemReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const [compactRail, setCompactRail] = useState(() => localStorage.getItem(STORAGE.compactRail) === "true");
  // 校对阶段需要把侧栏压窄让出编辑宽度，但不能因此改写用户自己的偏好。
  const [railAutoCompact, setRailAutoCompact] = useState(false);
  const [keymap, setKeymapState] = useState<KeymapId>(storedKeymap);
  const [density, setDensity] = useState<Density>(() => localStorage.getItem(STORAGE.density) === "pro" ? "pro" : "simple");
  // 切完开关用户才去点某一页，所以"哪里变了"这个提示必须跨页面存活。
  const [densityReveal, setDensityReveal] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const refreshSequence = useRef(0);
  const themeSwitchTimer = useRef<number | null>(null);
  const themeRef = useRef(theme);
  const soundEnabledRef = useRef(soundEnabled);
  const reducedMotion = systemReducedMotion || reducedMotionForced;
  const effectsActive = effectsEnabled && !reducedMotion && pageVisible;

  themeRef.current = theme;
  soundEnabledRef.current = soundEnabled;

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setProjects((current) => ({ ...current, loading: true, error: null }));
    setReadiness((current) => ({ ...current, loading: true, error: null }));
    setAsr((current) => ({ ...current, loading: true, error: null }));
    setAsrDevice((current) => ({ ...current, loading: true, error: null }));
    try {
      const [projectResult, readinessResult, asrResult, deviceResult] = await Promise.all([
        desktopListRecentProjects(),
        desktopGetCapabilityReadiness(),
        desktopGetAsrCapabilityStatus(),
        desktopGetAsrDeviceStatus(),
      ]);
      if (sequence !== refreshSequence.current) return;
      setProjects(resultState(projectResult));
      setReadiness(resultState(readinessResult));
      setAsr(resultState(asrResult));
      setAsrDevice(resultState(deviceResult));
    } catch (error) {
      if (sequence !== refreshSequence.current) return;
      const message = rejectedCallText(error);
      setProjects({ data: null, loading: false, error: message });
      setReadiness({ data: null, loading: false, error: message });
      setAsr({ data: null, loading: false, error: message });
      setAsrDevice({ data: null, loading: false, error: message });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const definition = THEME_BY_ID[theme];
    root.dataset.theme = theme;
    root.dataset.signature = definition.signature;
    root.dataset.effects = effectsActive ? "on" : "off";
    root.dataset.reducedMotion = String(reducedMotion);
    root.classList.toggle("effects-off", !effectsActive);
    root.classList.toggle("reduce-motion", reducedMotion);
    root.classList.toggle("rail-compact", compactRail || railAutoCompact);
    root.classList.toggle("density-pro", density === "pro");
    root.classList.toggle("density-just-on", densityReveal);
    root.style.colorScheme = definition.colorScheme;
    document.title = `${definition.name} · 桌面 AI 翻译器`;
    localStorage.setItem(STORAGE.theme, theme);
    localStorage.setItem(STORAGE.sound, String(soundEnabled));
    localStorage.setItem(STORAGE.effects, String(effectsEnabled));
    localStorage.setItem(STORAGE.reducedMotion, String(reducedMotionForced));
    localStorage.setItem(STORAGE.compactRail, String(compactRail));
  }, [compactRail, density, densityReveal, railAutoCompact, effectsActive, effectsEnabled, reducedMotion, reducedMotionForced, soundEnabled, theme]);

  // 提示要活到用户走到目标页面，但不能一直挂着。没人理它就自己收掉。
  useEffect(() => {
    if (!densityReveal) return;
    const timer = window.setTimeout(() => setDensityReveal(false), 45_000);
    return () => window.clearTimeout(timer);
  }, [densityReveal]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setSystemReducedMotion(media.matches);
    const updateVisibility = () => {
      const visible = document.visibilityState !== "hidden";
      setPageVisible(visible);
      if (!visible) disposeThemeSound();
    };
    media.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      media.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  useEffect(() => {
    const silence = () => disposeThemeSound();
    window.addEventListener("blur", silence);
    return () => {
      window.removeEventListener("blur", silence);
      if (themeSwitchTimer.current !== null) window.clearTimeout(themeSwitchTimer.current);
      disposeThemeSound();
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const flushUiState = useCallback(() => {
    localStorage.setItem(STORAGE.theme, theme);
    localStorage.setItem(STORAGE.sound, String(soundEnabled));
    localStorage.setItem(STORAGE.effects, String(effectsEnabled));
    localStorage.setItem(STORAGE.reducedMotion, String(reducedMotionForced));
    localStorage.setItem(STORAGE.compactRail, String(compactRail));
  }, [compactRail, effectsEnabled, reducedMotionForced, soundEnabled, theme]);

  const play = useCallback((sound: UiSound) => {
    if (soundEnabledRef.current) playThemeSound(sound, themeRef.current);
  }, []);

  const setTheme = useCallback((nextTheme: ThemeId) => {
    if (nextTheme === themeRef.current) return;
    document.documentElement.classList.add("theme-switching");
    setThemeState(nextTheme);
    localStorage.setItem(STORAGE.theme, nextTheme);
    if (soundEnabledRef.current) playThemeSound("success", nextTheme);
    setNotice({ tone: "status", message: `已切换至“${THEME_BY_ID[nextTheme].name}”；页面与业务状态保持不变` });
    if (themeSwitchTimer.current !== null) window.clearTimeout(themeSwitchTimer.current);
    themeSwitchTimer.current = window.setTimeout(() => {
      document.documentElement.classList.remove("theme-switching");
      themeSwitchTimer.current = null;
    }, 380);
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled((current) => {
      const next = !current;
      soundEnabledRef.current = next;
      localStorage.setItem(STORAGE.sound, String(next));
      if (next) playThemeSound("success", themeRef.current);
      else disposeThemeSound();
      setNotice({ tone: "status", message: next ? `操作音效已开启（${THEME_BY_ID[themeRef.current].name}材质配方）` : "操作音效已静音" });
      return next;
    });
  }, []);

  const toggleEffects = useCallback(() => {
    setEffectsEnabled((current) => {
      const next = !current;
      localStorage.setItem(STORAGE.effects, String(next));
      setNotice({ tone: "status", message: next ? "签名视觉动效已开启" : "签名视觉动效已关闭；业务反馈保持可见" });
      return next;
    });
  }, []);

  const toggleReducedMotion = useCallback(() => {
    setReducedMotionForced((current) => {
      const next = !current;
      localStorage.setItem(STORAGE.reducedMotion, String(next));
      setNotice({ tone: "status", message: next ? "已主动启用减少动态" : systemReducedMotion ? "Windows 减少动态仍然生效" : "已恢复标准短动效" });
      return next;
    });
  }, [systemReducedMotion]);

  const toggleRail = useCallback(() => {
    play("toggle");
    setCompactRail((current) => !current);
  }, [play]);

  const toggleDensity = useCallback(() => {
    setDensity((current) => {
      const next = current === "simple" ? "pro" : "simple";
      localStorage.setItem(STORAGE.density, next);
      const root = document.documentElement;
      root.classList.remove("density-just-off");
      // 强制重排，保证连续切换时动画会重新播放而不是被合并掉
      void root.offsetWidth;
      if (next === "pro") {
        // 开启：读数发光要等用户走到目标页面才有意义，所以由 densityReveal 驱动 class，
        // 而不是在这里定一个 4 秒的定时器——那个窗口在他到达之前就结束了。
        setDensityReveal(true);
      } else {
        // 关闭：侧栏闪一下表示"收到，已经收起来了"，不需要跨页面。
        setDensityReveal(false);
        root.classList.add("density-just-off");
        window.setTimeout(() => root.classList.remove("density-just-off"), 4_000);
      }
      return next;
    });
    play("toggle");
  }, [play]);

  const dismissDensityReveal = useCallback(() => setDensityReveal(false), []);

  const setKeymap = useCallback((next: KeymapId) => {
    localStorage.setItem(STORAGE.keymap, next);
    setKeymapState(next);
    play("toggle");
  }, [play]);

  const openProject = useCallback(async (projectId: string) => {
    setOpeningProjectId(projectId);
    let result;
    try {
      result = await desktopOpenProject(projectId);
    } catch (error) {
      setOpeningProjectId(null);
      setNotice({ tone: "error", message: rejectedCallText(error) });
      return false;
    }
    setOpeningProjectId(null);
    if (!result.ok) {
      setNotice({ tone: "error", message: localizeIpcErrorText(result.error) });
      return false;
    }
    if (!result.data) {
      setNotice({ tone: "error", message: "找不到这个项目；它可能已经移动或删除。" });
      return false;
    }
    setActiveProject(result.data);
    setNotice({ tone: "status", message: `已打开“${result.data.title}”` });
    return true;
  }, []);

  const controlWindow = useCallback(async (action: WindowControlAction) => {
    play(action === "close" ? "warning" : "click");
    if (action === "close") {
      flushUiState();
      if (!(await workspace.flushBeforeClose())) {
        setNotice({ tone: "error", message: "仍有项目未能保存，窗口保持打开；请处理保存错误后重试。" });
        return;
      }
    }
    try {
      const result = await desktopWindowControl(action);
      if (!result.ok) setNotice({ tone: "error", message: localizeIpcErrorText(result.error) });
    } catch (error) {
      if (action !== "close") setNotice({ tone: "error", message: rejectedCallText(error) });
    }
  }, [flushUiState, play, workspace.flushBeforeClose]);

  return (
    <FrontendContext.Provider value={{
      desktopAvailable,
      projects,
      readiness,
      asr,
      asrDevice,
      activeProject,
      openingProjectId,
      theme,
      soundEnabled,
      effectsEnabled,
      reducedMotionForced,
      reducedMotion,
      effectsActive,
      compactRail,
      setRailAutoCompact,
      keymap,
      setKeymap,
      density,
      toggleDensity,
      densityReveal,
      dismissDensityReveal,
      notice,
      refresh,
      openProject,
      play,
      setTheme,
      toggleSound,
      toggleEffects,
      toggleReducedMotion,
      toggleRail,
      controlWindow,
    }}>
      {children}
    </FrontendContext.Provider>
  );
}

export function useFrontend() {
  const value = useContext(FrontendContext);
  if (!value) throw new Error("useFrontend must be used inside FrontendProvider");
  return value;
}
