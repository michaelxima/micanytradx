"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Activity,
  TrendingDown,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Radio,
  Zap,
  Settings,
  ArrowUpRight,
  ArrowDownRight,
  Layers,
  Bell,
  Volume2,
  VolumeX,
  Sliders,
  ShieldCheck,
  BarChart3,
} from "lucide-react";

interface Signal {
  id: string;
  strategy_id?: string;
  strategy_name?: string;
  symbol: string;
  signal_type: "BUY" | "SELL";
  suggested_price: string | number;
  rsi_at_signal?: number | string;
  ema_fast_at_signal?: number | string;
  ema_slow_at_signal?: number | string;
  status: "pending_review" | "executed" | "ignored" | "expired";
  generated_at?: string;
}

interface Trade {
  id: string;
  signal_id?: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entry_price: string | number;
  quantity: string | number;
  stop_loss_price: string | number;
  status: "OPEN" | "CLOSED";
  exit_price?: string | number;
  pnl_absolute?: string | number;
  pnl_percentage?: string | number;
  opened_at?: string;
  closed_at?: string;
}

// Phase D analytics shapes
interface PerformanceMetrics {
  total_closed: number | string;
  winning_trades: number | string;
  losing_trades: number | string;
  win_rate: number | string;
  profit_factor: number | string;
  net_pnl: number | string;
  avg_slippage_percent?: number | string | null;
}

interface LivePosition {
  tradeId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  stopLossPrice?: number | null;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export default function TradingDashboard() {
  // Config & API State
  // Default to the deployed Railway backend so a production build works even
  // without NEXT_PUBLIC_API_URL set. Override order:
  //   1. NEXT_PUBLIC_API_URL (build-time env, if provided)
  //   2. this baked-in production default
  // For local dev, use the in-app Settings override or set NEXT_PUBLIC_API_URL
  // to http://localhost:3000 in a local .env.local.
  const [apiUrl, setApiUrl] = useState(
    process.env.NEXT_PUBLIC_API_URL || "https://micanytradx-production.up.railway.app"
  );
  const [isApiOnline, setIsApiOnline] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);

  // Live Binance Stream
  const [livePrice, setLivePrice] = useState<number>(0);
  const [priceDirection, setPriceDirection] = useState<"up" | "down" | "flat">("flat");
  const [candleHigh, setCandleHigh] = useState<number>(0);
  const [candleLow, setCandleLow] = useState<number>(0);

  // Core Trading State
  const [pendingSignals, setPendingSignals] = useState<Signal[]>([]);
  const [openTrades, setOpenTrades] = useState<Trade[]>([]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Phase D: Analytics & live unrealized P&L
  const [analytics, setAnalytics] = useState<PerformanceMetrics | null>(null);
  const [livePositions, setLivePositions] = useState<LivePosition[]>([]);

  // Modals & Action States
  const [selectedSignal, setSelectedSignal] = useState<Signal | null>(null);
  const [buyQuantity, setBuyQuantity] = useState("0.1");
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmSellTrade, setConfirmSellTrade] = useState<Trade | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Load the browser-specific API target after hydration.
  useEffect(() => {
    const loadSavedApiUrl = setTimeout(() => {
      const saved = localStorage.getItem("micanytradx_api_url");
      if (saved) setApiUrl(saved);
    }, 0);
    return () => clearTimeout(loadSavedApiUrl);
  }, []);

  // Play Alert Beep
  const playAlertSound = useCallback(() => {
    if (!soundEnabled || typeof window === "undefined") return;
    try {
      const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.3);
    } catch {
      // AudioContext blocked by autoplay policy
    }
  }, [soundEnabled]);

  // Connect to Live Binance WebSocket for real-time BTCUSDT 15m candle updates
  useEffect(() => {
    const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@kline_15m");

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.k) {
          const current = parseFloat(data.k.c);
          const high = parseFloat(data.k.h);
          const low = parseFloat(data.k.l);
          setCandleHigh(high);
          setCandleLow(low);

          setLivePrice((prev) => {
            if (current > prev) setPriceDirection("up");
            else if (current < prev) setPriceDirection("down");
            return current;
          });
        }
      } catch {
        // ignore parse error
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  // Fetch API Health & Data
  const fetchData = useCallback(async () => {
    setIsRefreshing(true);
    try {
      // 1. Health check
      const healthRes = await fetch(`${apiUrl}/api/health`, { cache: "no-store" }).catch(() => null);
      if (healthRes && healthRes.ok) {
        setIsApiOnline(true);
      } else {
        setIsApiOnline(false);
      }

      // 2. Pending Signals
      const sigRes = await fetch(`${apiUrl}/api/signals/pending`, { cache: "no-store" }).catch(() => null);
      if (sigRes && sigRes.ok) {
        const sigData = await sigRes.json();
        if (sigData.success && Array.isArray(sigData.signals)) {
          setPendingSignals((prev) => {
            if (sigData.signals.length > prev.length) {
              playAlertSound();
            }
            return sigData.signals;
          });
        }
      }

      // 3. Open Trades
      const tradesRes = await fetch(`${apiUrl}/api/trades/open`, { cache: "no-store" }).catch(() => null);
      if (tradesRes && tradesRes.ok) {
        const tradesData = await tradesRes.json();
        if (tradesData.success && Array.isArray(tradesData.trades)) {
          setOpenTrades(tradesData.trades);
        }
      }

      // 4. Analytics: performance + slippage (merged into one object for the KPI row)
      const [perfRes, slipRes, unrealizedRes] = await Promise.all([
        fetch(`${apiUrl}/api/analytics/performance`, { cache: "no-store" }).catch(() => null),
        fetch(`${apiUrl}/api/analytics/slippage`, { cache: "no-store" }).catch(() => null),
        fetch(`${apiUrl}/api/trades/unrealized`, { cache: "no-store" }).catch(() => null),
      ]);

      if (perfRes && perfRes.ok) {
        const perfData = await perfRes.json();
        if (perfData.success && perfData.data) {
          let merged: PerformanceMetrics = perfData.data;
          if (slipRes && slipRes.ok) {
            const slipData = await slipRes.json();
            if (slipData.success && slipData.data) {
              merged = { ...merged, avg_slippage_percent: slipData.data.avg_slippage_percent };
            }
          }
          setAnalytics(merged);
        }
      }

      if (unrealizedRes && unrealizedRes.ok) {
        const unrealizedData = await unrealizedRes.json();
        if (unrealizedData.success && Array.isArray(unrealizedData.data)) {
          setLivePositions(unrealizedData.data);
        }
      }

    } catch {
      setIsApiOnline(false);
    } finally {
      setIsRefreshing(false);
    }
  }, [apiUrl, playAlertSound]);

  // Polling Interval
  useEffect(() => {
    const initialFetch = setTimeout(fetchData, 0);
    // Phase D: poll every 3s for live analytics + unrealized P&L (overridable).
    const pollMs = Number(process.env.NEXT_PUBLIC_POLL_INTERVAL_MS) || 3000;
    const interval = setInterval(fetchData, pollMs);
    return () => {
      clearTimeout(initialFetch);
      clearInterval(interval);
    };
  }, [fetchData]);

  // Save Settings
  const handleSaveApiUrl = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem("micanytradx_api_url", apiUrl);
    setShowSettings(false);
    setStatusMessage({ type: "success", text: `Backend API target saved: ${apiUrl}` });
    fetchData();
    setTimeout(() => setStatusMessage(null), 4000);
  };

  // Confirm Buy
  const handleConfirmBuy = async () => {
    if (!selectedSignal) return;
    setActionLoading(true);
    setStatusMessage(null);

    const priceToUse = livePrice > 0 ? livePrice : parseFloat(String(selectedSignal.suggested_price));

    try {
      if (isApiOnline) {
        const res = await fetch(`${apiUrl}/api/trades/confirm-buy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signalId: selectedSignal.id,
            quantity: parseFloat(buyQuantity) || 0.1,
            confirmedPrice: priceToUse,
          }),
        });
        const data = await res.json();
        if (data.success) {
          setStatusMessage({ type: "success", text: `Trade executed! Trade ID: ${data.tradeId}` });
          setSelectedSignal(null);
          fetchData();
        } else {
          setStatusMessage({ type: "error", text: data.error || "Failed to confirm buy" });
        }
      } else {
        // Client-side simulation fallback when API not connected
        const simulatedTrade: Trade = {
          id: `sim-${Date.now().toString().slice(-4)}`,
          signal_id: selectedSignal.id,
          symbol: selectedSignal.symbol,
          side: "LONG",
          entry_price: priceToUse,
          quantity: buyQuantity,
          stop_loss_price: priceToUse * 0.975,
          status: "OPEN",
          opened_at: new Date().toISOString(),
        };
        setOpenTrades((prev) => [simulatedTrade, ...prev]);
        setPendingSignals((prev) => prev.filter((s) => s.id !== selectedSignal.id));
        setSelectedSignal(null);
        setStatusMessage({ type: "success", text: `[DEMO MODE] Trade entered at $${priceToUse.toLocaleString()}` });
      }
    } catch (err: unknown) {
      setStatusMessage({ type: "error", text: (err as Error).message });
    } finally {
      setActionLoading(false);
      setTimeout(() => setStatusMessage(null), 5000);
    }
  };

  // Confirm Sell
  const handleConfirmSell = async (trade: Trade) => {
    setActionLoading(true);
    setStatusMessage(null);
    const exitPriceToUse = livePrice > 0 ? livePrice : parseFloat(String(trade.entry_price));

    try {
      if (isApiOnline) {
        const res = await fetch(`${apiUrl}/api/trades/confirm-sell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tradeId: trade.id,
            exitPrice: exitPriceToUse,
            reason: "manual_dashboard_exit",
          }),
        });
        const data = await res.json();
        if (data.success) {
          setStatusMessage({
            type: "success",
            text: `Position closed! P&L: ${data.pnlPercentage ? Number(data.pnlPercentage).toFixed(2) : 0}%`,
          });
          setConfirmSellTrade(null);
          fetchData();
        } else {
          setStatusMessage({ type: "error", text: data.error || "Failed to close trade" });
        }
      } else {
        // Client-side simulation fallback
        const entry = parseFloat(String(trade.entry_price));
        const qty = parseFloat(String(trade.quantity));
        const pnlAbs = (exitPriceToUse - entry) * qty;
        const pnlPct = ((exitPriceToUse - entry) / entry) * 100;

        const closed: Trade = {
          ...trade,
          status: "CLOSED",
          exit_price: exitPriceToUse,
          pnl_absolute: pnlAbs,
          pnl_percentage: pnlPct,
          closed_at: new Date().toISOString(),
        };

        setOpenTrades((prev) => prev.filter((t) => t.id !== trade.id));
        setClosedTrades((prev) => [closed, ...prev]);
        setConfirmSellTrade(null);
        setStatusMessage({
          type: "success",
          text: `[DEMO MODE] Trade closed at $${exitPriceToUse.toLocaleString()} | P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
        });
      }
    } catch (err: unknown) {
      setStatusMessage({ type: "error", text: (err as Error).message });
    } finally {
      setActionLoading(false);
      setTimeout(() => setStatusMessage(null), 5000);
    }
  };

  // Inject Demo Signal for testing
  const injectDemoSignal = () => {
    const currentP = livePrice > 0 ? livePrice : 67450.0;
    const newSignal: Signal = {
      id: `demo-${Date.now().toString().slice(-4)}`,
      strategy_name: "EMA Pullback Momentum (15m)",
      symbol: "BTCUSDT",
      signal_type: "BUY",
      suggested_price: currentP,
      rsi_at_signal: 48.2,
      ema_fast_at_signal: currentP + 80,
      ema_slow_at_signal: currentP - 120,
      status: "pending_review",
      generated_at: new Date().toISOString(),
    };
    setPendingSignals((prev) => [newSignal, ...prev]);
    playAlertSound();
    setStatusMessage({ type: "success", text: "Demo BUY signal injected! Review it below." });
    setTimeout(() => setStatusMessage(null), 4000);
  };

  return (
    <div className="min-h-screen bg-[#070b13] text-slate-100 flex flex-col selection:bg-emerald-500 selection:text-black">
      {/* Top Navigation Header */}
      <header className="border-b border-slate-800/80 bg-[#0c1220]/90 backdrop-blur-md sticky top-0 z-40 px-4 lg:px-8 py-3.5">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          {/* Logo & Platform Tag */}
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-emerald-500 via-teal-400 to-cyan-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Zap className="h-5 w-5 text-black stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
                  MICANY<span className="text-emerald-400">TRADX</span>
                </span>
                <span className="text-[10px] uppercase font-bold tracking-widest px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                  PRO TERMINAL
                </span>
              </div>
              <p className="text-[11px] text-slate-400">Algorithmic Signal Engine & Human Confirmation</p>
            </div>
          </div>

          {/* Live Binance Price Ticker */}
          <div className="flex items-center gap-6 bg-[#090d16] border border-slate-800 rounded-xl px-4 py-2 shadow-inner">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span className="font-semibold text-xs text-slate-300 tracking-wider">BTC / USDT</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span
                className={`text-lg font-mono font-bold transition-colors ${
                  priceDirection === "up" ? "text-emerald-400" : priceDirection === "down" ? "text-rose-400" : "text-white"
                }`}
              >
                ${livePrice > 0 ? livePrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "Connecting..."}
              </span>
              {livePrice > 0 && (
                <span className="text-[10px] text-slate-400 flex items-center font-mono">
                  {priceDirection === "up" ? (
                    <ArrowUpRight className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <ArrowDownRight className="h-3 w-3 text-rose-400" />
                  )}
                  15m
                </span>
              )}
            </div>
            {candleHigh > 0 && (
              <div className="hidden sm:flex text-[11px] font-mono text-slate-400 gap-3 border-l border-slate-800 pl-3">
                <span>
                  H: <strong className="text-slate-200">${candleHigh.toLocaleString()}</strong>
                </span>
                <span>
                  L: <strong className="text-slate-200">${candleLow.toLocaleString()}</strong>
                </span>
              </div>
            )}
          </div>

          {/* Controls: Engine Status, Sound, Settings */}
          <div className="flex items-center gap-3">
            {/* Backend Status Badge */}
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium ${
                isApiOnline
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : isApiOnline === false
                  ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
                  : "bg-slate-800/50 border-slate-700 text-slate-400"
              }`}
            >
              <Radio className={`h-3 w-3 ${isApiOnline ? "text-emerald-400 animate-pulse" : "text-amber-400"}`} />
              <span>{isApiOnline ? "Engine Online" : "Demo Mode"}</span>
            </div>

            {/* Sound Toggle */}
            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              title={soundEnabled ? "Mute alerts" : "Enable sound alerts"}
              className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white transition"
            >
              {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4 text-slate-500" />}
            </button>

            {/* Refresh */}
            <button
              onClick={fetchData}
              disabled={isRefreshing}
              title="Refresh Data"
              className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white transition disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin text-emerald-400" : ""}`} />
            </button>

            {/* Settings Trigger */}
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="p-2 rounded-lg bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white transition"
              title="API Configuration"
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Settings Drawer / Flyout */}
      {showSettings && (
        <div className="border-b border-slate-800 bg-[#0e1626] p-4 lg:px-8 animate-in slide-in-from-top-2">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Sliders className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-white">Backend Engine Configuration:</span>
              <span className="text-xs text-slate-400">
                Specify your local or remote Express API endpoint (e.g. Render, Railway, localhost:3000)
              </span>
            </div>
            <form onSubmit={handleSaveApiUrl} className="flex items-center gap-2 w-full md:w-auto">
              <input
                type="text"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="http://localhost:3000"
                className="bg-slate-900 border border-slate-700 text-sm rounded-lg px-3 py-1.5 text-white focus:outline-none focus:border-emerald-500 font-mono w-full md:w-80"
              />
              <button
                type="submit"
                className="px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-xs transition"
              >
                Save
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Global Status Banner Alert */}
      {statusMessage && (
        <div
          className={`px-4 py-2 text-center text-xs font-semibold ${
            statusMessage.type === "success"
              ? "bg-emerald-500/20 text-emerald-300 border-b border-emerald-500/30"
              : "bg-rose-500/20 text-rose-300 border-b border-rose-500/30"
          }`}
        >
          {statusMessage.text}
        </div>
      )}

      {/* Main Trading Cockpit */}
      <main className="max-w-7xl mx-auto w-full p-4 lg:p-8 flex-1 flex flex-col gap-6">
        {/* Phase D: Analytics KPI Row */}
        {analytics && (
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-[#0f172a]/70 border border-slate-800/80 rounded-2xl p-4">
              <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
                <span className="font-medium">WIN RATE</span>
                <BarChart3 className="h-4 w-4 text-emerald-400" />
              </div>
              <div className="text-2xl font-bold text-emerald-400">{analytics.win_rate}%</div>
              <div className="text-xs text-slate-500">
                {analytics.winning_trades}W / {analytics.losing_trades}L
              </div>
            </div>
            <div className="bg-[#0f172a]/70 border border-slate-800/80 rounded-2xl p-4">
              <div className="text-slate-400 text-xs font-medium mb-1">PROFIT FACTOR</div>
              <div className={`text-2xl font-bold ${Number(analytics.profit_factor) >= 1.5 ? "text-emerald-400" : "text-amber-400"}`}>
                {analytics.profit_factor}
              </div>
              <div className="text-xs text-slate-500">Gross Profit / Gross Loss</div>
            </div>
            <div className="bg-[#0f172a]/70 border border-slate-800/80 rounded-2xl p-4">
              <div className="text-slate-400 text-xs font-medium mb-1">NET P&amp;L</div>
              <div className={`text-2xl font-bold ${Number(analytics.net_pnl) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                ${Number(analytics.net_pnl).toFixed(2)}
              </div>
              <div className="text-xs text-slate-500">{analytics.total_closed} Total Trades</div>
            </div>
            <div className="bg-[#0f172a]/70 border border-slate-800/80 rounded-2xl p-4">
              <div className="text-slate-400 text-xs font-medium mb-1">AVG SLIPPAGE</div>
              <div className="text-2xl font-bold text-cyan-400">
                {analytics.avg_slippage_percent != null ? analytics.avg_slippage_percent : "0.00"}%
              </div>
              <div className="text-xs text-slate-500">Execution Quality</div>
            </div>
          </section>
        )}

        {/* KPI & Market Pulse Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Card 1: Live Engine Status */}
          <div className="bg-[#0f172a]/70 border border-slate-800/80 rounded-2xl p-4 flex flex-col justify-between hover:border-slate-700 transition shadow-lg">
            <div className="flex items-center justify-between text-slate-400 text-xs">
              <span className="font-medium">STRATEGY ENGINE</span>
              <Layers className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="my-2">
              <div className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                EMA 9/21 Pullback
              </div>
              <p className="text-xs text-slate-400 mt-0.5">Timeframe: 15m Candles | Asset: BTC</p>
            </div>
            <div className="text-[11px] text-emerald-400 flex items-center gap-1.5 font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping"></span>
              Real-time WebSocket Active
            </div>
          </div>

          {/* Card 2: Pending Human Review */}
          <div className="bg-[#0f172a]/70 border border-slate-800/80 rounded-2xl p-4 flex flex-col justify-between hover:border-slate-700 transition shadow-lg">
            <div className="flex items-center justify-between text-slate-400 text-xs">
              <span className="font-medium">PENDING REVIEW</span>
              <Bell className="h-4 w-4 text-amber-400" />
            </div>
            <div className="my-2">
              <div className="text-3xl font-mono font-extrabold text-amber-400">{pendingSignals.length}</div>
              <p className="text-xs text-slate-400 mt-0.5">Awaiting human entry confirmation</p>
            </div>
            <div className="text-[11px] text-slate-400">2.5% hard stop-loss calculated on entry</div>
          </div>

          {/* Card 3: Active Positions */}
          <div className="bg-[#0f172a]/70 border border-slate-800/80 rounded-2xl p-4 flex flex-col justify-between hover:border-slate-700 transition shadow-lg">
            <div className="flex items-center justify-between text-slate-400 text-xs">
              <span className="font-medium">ACTIVE POSITIONS</span>
              <Activity className="h-4 w-4 text-cyan-400" />
            </div>
            <div className="my-2">
              <div className="text-3xl font-mono font-extrabold text-white">{openTrades.length}</div>
              <p className="text-xs text-slate-400 mt-0.5">Monitoring live exit conditions</p>
            </div>
            <div className="text-[11px] text-cyan-400 font-medium">Exit on Trend Reversal or Stop-Loss</div>
          </div>

          {/* Card 4: Action Tools / Demo Generator */}
          <div className="bg-gradient-to-br from-[#0f172a] to-[#141e33] border border-emerald-500/30 rounded-2xl p-4 flex flex-col justify-between shadow-lg">
            <div className="flex items-center justify-between text-slate-400 text-xs">
              <span className="font-medium text-emerald-400">INTERACTIVE ACTION</span>
              <Zap className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="my-1">
              <p className="text-xs text-slate-300">Test human-in-the-loop signal triggers & executions</p>
            </div>
            <button
              onClick={injectDemoSignal}
              className="w-full mt-2 py-2 px-3 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-semibold text-xs flex items-center justify-center gap-1.5 transition active:scale-[0.98]"
            >
              <Zap className="h-3.5 w-3.5" />
              Generate Demo Buy Signal
            </button>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* SECTION: PENDING SIGNALS (HUMAN-IN-THE-LOOP CORE) */}
        {/* ========================================================================= */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-amber-400 animate-ping"></div>
              <h2 className="text-base font-bold tracking-tight text-white flex items-center gap-2">
                Pending Trade Signals
                <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  {pendingSignals.length} Action Required
                </span>
              </h2>
            </div>
            <span className="text-xs text-slate-400">Signals require manual confirmation to execute</span>
          </div>

          {pendingSignals.length === 0 ? (
            <div className="bg-[#0f172a]/40 border border-dashed border-slate-800 rounded-2xl p-10 flex flex-col items-center justify-center text-center">
              <div className="relative mb-3 flex items-center justify-center">
                <span className="absolute h-12 w-12 rounded-full bg-emerald-500/20 radar-ping"></span>
                <Radio className="h-8 w-8 text-emerald-400 relative z-10" />
              </div>
              <h3 className="font-semibold text-slate-200 text-sm">Engine Active & Scanning Market</h3>
              <p className="text-xs text-slate-400 max-w-md mt-1">
                Strategy engine is evaluating closed 15m candles on BTC/USDT. When an EMA 9 &gt; EMA 21 bullish cross occurs with RSI &lt; 65, an actionable signal will trigger here.
              </p>
              <button
                onClick={injectDemoSignal}
                className="mt-4 text-xs text-emerald-400 hover:text-emerald-300 underline font-medium"
              >
                Or inject a test signal now to simulate the review flow
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {pendingSignals.map((signal) => {
                const sugPrice = parseFloat(String(signal.suggested_price));
                const stopLossEstimate = sugPrice * (1 - 0.025);
                return (
                  <div
                    key={signal.id}
                    className="bg-gradient-to-b from-[#131d33] to-[#0d1424] border-2 border-amber-500/50 rounded-2xl p-5 shadow-xl shadow-amber-950/20 flex flex-col justify-between relative overflow-hidden"
                  >
                    {/* Top banner tag */}
                    <div className="flex items-center justify-between border-b border-slate-800/80 pb-3 mb-3">
                      <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                        <ArrowUpRight className="h-3 w-3" />
                        {signal.signal_type} SIGNAL
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">
                        {signal.generated_at ? new Date(signal.generated_at).toLocaleTimeString() : "Just now"}
                      </span>
                    </div>

                    {/* Signal Info */}
                    <div className="space-y-3">
                      <div>
                        <div className="text-xl font-bold font-mono text-white flex items-center justify-between">
                          <span>{signal.symbol}</span>
                          <span className="text-emerald-400">${sugPrice.toLocaleString()}</span>
                        </div>
                        <p className="text-xs text-slate-400">{signal.strategy_name || "EMA 9/21 Pullback Momentum"}</p>
                      </div>

                      {/* Technical Indicators Snapshot */}
                      <div className="grid grid-cols-3 gap-2 bg-[#090d16]/70 p-2.5 rounded-xl border border-slate-800/80 text-[11px] font-mono">
                        <div>
                          <span className="text-slate-500 block text-[10px]">RSI (14)</span>
                          <span className="text-emerald-400 font-semibold">
                            {signal.rsi_at_signal ? Number(signal.rsi_at_signal).toFixed(1) : "52.4"}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 block text-[10px]">EMA (9)</span>
                          <span className="text-cyan-400 font-semibold">
                            ${signal.ema_fast_at_signal ? Number(signal.ema_fast_at_signal).toLocaleString() : (sugPrice + 50).toLocaleString()}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 block text-[10px]">EMA (21)</span>
                          <span className="text-slate-300 font-semibold">
                            ${signal.ema_slow_at_signal ? Number(signal.ema_slow_at_signal).toLocaleString() : (sugPrice - 50).toLocaleString()}
                          </span>
                        </div>
                      </div>

                      {/* Stop loss notice */}
                      <div className="flex items-center justify-between text-xs text-slate-400 bg-rose-500/10 border border-rose-500/20 px-3 py-1.5 rounded-lg">
                        <span className="flex items-center gap-1 text-rose-300">
                          <ShieldAlert className="h-3.5 w-3.5" />
                          Stop-Loss (2.5%):
                        </span>
                        <span className="font-mono font-semibold text-rose-300">
                          ${stopLossEstimate.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>

                    {/* Action Execution Button */}
                    <div className="pt-4 mt-2 border-t border-slate-800/80 flex items-center gap-2">
                      <button
                        onClick={() => setSelectedSignal(signal)}
                        className="flex-1 py-2.5 px-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-black font-bold text-xs tracking-wide shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-1.5 transition active:scale-[0.98]"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        REVIEW &amp; CONFIRM BUY
                      </button>
                      <button
                        onClick={() => setPendingSignals((prev) => prev.filter((s) => s.id !== signal.id))}
                        className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition"
                        title="Dismiss"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ========================================================================= */}
        {/* SECTION: OPEN POSITIONS (ACTIVE TRADES) */}
        {/* ========================================================================= */}
        <section className="flex flex-col gap-3 mt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold tracking-tight text-white flex items-center gap-2">
              <Activity className="h-4 w-4 text-cyan-400" />
              Active Monitored Trades
              <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
                {openTrades.length} Open
              </span>
            </h2>
            <span className="text-xs text-slate-400">Engine actively watches for EMA Bearish Cross or Stop-Loss</span>
          </div>

          {openTrades.length === 0 ? (
            <div className="bg-[#0f172a]/30 border border-slate-800/60 rounded-2xl p-8 text-center text-slate-400 text-xs">
              No active trades open. Confirmed buy signals will populate this monitored list.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-[#0f172a]/80 shadow-xl">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#0a0f1d] border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                  <tr>
                    <th className="p-3.5 pl-5">Asset / Side</th>
                    <th className="p-3.5">Quantity</th>
                    <th className="p-3.5">Entry Price</th>
                    <th className="p-3.5">Stop-Loss Price</th>
                    <th className="p-3.5">Current Live Price</th>
                    <th className="p-3.5">Unrealized P&amp;L</th>
                    <th className="p-3.5 text-right pr-5">Exit Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {openTrades.map((trade) => {
                    const entry = parseFloat(String(trade.entry_price));
                    const qty = parseFloat(String(trade.quantity));
                    // Backend is the SINGLE SOURCE OF TRUTH for unrealized P&L:
                    // /api/trades/unrealized is commission-aware and priced off
                    // the same feed the engine trades on. We do NOT fall back to
                    // the local mainnet ticker, because that produces a figure
                    // that contradicts the engine. If the backend hasn't reported
                    // yet, we show a neutral "awaiting" state instead.
                    const live = livePositions.find((p) => p.tradeId === trade.id);
                    const hasBackend = live !== undefined;
                    const current = hasBackend ? live.currentPrice : null;
                    const pnlAbs = hasBackend ? live.unrealizedPnl : null;
                    const pnlPct = hasBackend ? live.unrealizedPnlPercent : null;
                    const isProfit = (pnlAbs ?? 0) >= 0;

                    return (
                      <tr key={trade.id} className="hover:bg-slate-800/40 transition">
                        <td className="p-3.5 pl-5 font-sans">
                          <div className="font-bold text-white flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-full bg-emerald-400"></span>
                            {trade.symbol}
                          </div>
                          <span className="text-[10px] text-emerald-400 font-bold tracking-wider">LONG</span>
                        </td>
                        <td className="p-3.5 text-slate-300 font-bold">{qty} BTC</td>
                        <td className="p-3.5 text-slate-200">${entry.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td className="p-3.5 text-rose-400 font-medium">
                          ${parseFloat(String(trade.stop_loss_price)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td className="p-3.5 font-bold text-white">
                          {current !== null
                            ? `$${current.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                            : <span className="text-slate-500 font-normal">—</span>}
                        </td>
                        <td className="p-3.5">
                          {pnlAbs !== null && pnlPct !== null ? (
                            <div
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-bold text-xs ${
                                isProfit
                                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                                  : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                              }`}
                            >
                              {isProfit ? "+" : ""}
                              {pnlPct.toFixed(2)}% (${isProfit ? "+" : ""}
                              {pnlAbs.toFixed(2)})
                            </div>
                          ) : (
                            <span className="text-slate-500 text-xs italic">awaiting engine…</span>
                          )}
                        </td>
                        <td className="p-3.5 text-right pr-5 font-sans">
                          <button
                            onClick={() => setConfirmSellTrade(trade)}
                            className="px-3.5 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 font-semibold text-xs transition active:scale-95"
                          >
                            Close Position
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Closed Trades History (if any) */}
        {closedTrades.length > 0 && (
          <section className="flex flex-col gap-3 mt-4">
            <h2 className="text-base font-bold tracking-tight text-white flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              Realized Trades History
            </h2>
            <div className="rounded-2xl border border-slate-800 bg-[#0f172a]/60 p-4">
              <div className="space-y-2">
                {closedTrades.map((t) => (
                  <div key={t.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 font-mono text-xs">
                    <div>
                      <span className="font-bold text-white">{t.symbol}</span>
                      <span className="text-slate-400 ml-2">Qty: {t.quantity}</span>
                    </div>
                    <div>
                      <span className="text-slate-400">Entry: ${Number(t.entry_price).toLocaleString()}</span>
                      <span className="text-slate-400 ml-3">Exit: ${Number(t.exit_price).toLocaleString()}</span>
                    </div>
                    <div className={`font-bold ${Number(t.pnl_percentage) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {Number(t.pnl_percentage) >= 0 ? "+" : ""}{Number(t.pnl_percentage).toFixed(2)}% (${Number(t.pnl_absolute).toFixed(2)})
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </main>

      {/* ========================================================================= */}
      {/* MODAL: BUY CONFIRMATION (HUMAN-IN-THE-LOOP) */}
      {/* ========================================================================= */}
      {selectedSignal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0f172a] border border-slate-700 max-w-lg w-full rounded-2xl p-6 shadow-2xl relative animate-in zoom-in-95">
            <button
              onClick={() => setSelectedSignal(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white"
            >
              <XCircle className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold uppercase tracking-wider mb-2">
              <Zap className="h-4 w-4" />
              Human-in-the-Loop Confirmation
            </div>
            <h3 className="text-xl font-bold text-white">Execute Long Position</h3>
            <p className="text-xs text-slate-400 mt-1">
              Confirming this entry opens a monitored trade on PostgreSQL and activates the live exit monitor.
            </p>

            <div className="my-5 p-4 rounded-xl bg-[#090d16] border border-slate-800 space-y-3 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400 font-sans">Trading Pair:</span>
                <span className="font-bold text-white">{selectedSignal.symbol} (SPOT / MARGIN)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400 font-sans">Current Market Price:</span>
                <span className="font-bold text-emerald-400">
                  ${(livePrice > 0 ? livePrice : parseFloat(String(selectedSignal.suggested_price))).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400 font-sans">Suggested Entry Price:</span>
                <span className="text-slate-300">${parseFloat(String(selectedSignal.suggested_price)).toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-rose-400">
                <span className="font-sans">Calculated Stop-Loss (-2.5%):</span>
                <span className="font-bold">
                  ${((livePrice > 0 ? livePrice : parseFloat(String(selectedSignal.suggested_price))) * 0.975).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            {/* Position Sizing Selector */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-300">Order Quantity (BTC):</label>
              <div className="flex gap-2">
                {["0.05", "0.1", "0.25", "0.5"].map((qty) => (
                  <button
                    key={qty}
                    type="button"
                    onClick={() => setBuyQuantity(qty)}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-mono font-semibold border transition ${
                      buyQuantity === qty
                        ? "bg-emerald-500 text-black border-emerald-400"
                        : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                    }`}
                  >
                    {qty} BTC
                  </button>
                ))}
              </div>
              <input
                type="number"
                step="0.01"
                value={buyQuantity}
                onChange={(e) => setBuyQuantity(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 font-mono text-sm text-white focus:outline-none focus:border-emerald-500"
              />
              <div className="text-[11px] text-slate-400 text-right font-mono">
                Est. Total Value: $
                {((parseFloat(buyQuantity) || 0) * (livePrice > 0 ? livePrice : parseFloat(String(selectedSignal.suggested_price)))).toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </div>
            </div>

            {/* Modal Actions */}
            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setSelectedSignal(null)}
                className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actionLoading}
                onClick={handleConfirmBuy}
                className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs shadow-lg shadow-emerald-500/25 transition disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {actionLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                CONFIRM &amp; EXECUTE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: SELL CONFIRMATION (EXIT TRADE) */}
      {/* ========================================================================= */}
      {confirmSellTrade && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0f172a] border border-slate-700 max-w-md w-full rounded-2xl p-6 shadow-2xl relative animate-in zoom-in-95">
            <button
              onClick={() => setConfirmSellTrade(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white"
            >
              <XCircle className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-2 text-rose-400 text-xs font-bold uppercase tracking-wider mb-2">
              <TrendingDown className="h-4 w-4" />
              Exit Trade
            </div>
            <h3 className="text-xl font-bold text-white">Close Open Position</h3>
            <p className="text-xs text-slate-400 mt-1">
              Executing this sell will log realized P&amp;L to PostgreSQL and flip the engine back to flat.
            </p>

            {(() => {
              const entry = parseFloat(String(confirmSellTrade.entry_price));
              const qty = parseFloat(String(confirmSellTrade.quantity));
              const current = livePrice > 0 ? livePrice : entry;
              const pnlPct = ((current - entry) / entry) * 100;
              const pnlAbs = (current - entry) * qty;
              const isProfit = pnlAbs >= 0;

              return (
                <div className="my-5 p-4 rounded-xl bg-[#090d16] border border-slate-800 space-y-2.5 font-mono text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-400 font-sans">Entry Price:</span>
                    <span className="text-white">${entry.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400 font-sans">Exit Market Price:</span>
                    <span className="font-bold text-white">${current.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between border-t border-slate-800 pt-2 text-sm font-bold">
                    <span className="font-sans">Estimated P&amp;L:</span>
                    <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
                      {isProfit ? "+" : ""}{pnlPct.toFixed(2)}% (${isProfit ? "+" : ""}{pnlAbs.toFixed(2)})
                    </span>
                  </div>
                </div>
              );
            })()}

            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setConfirmSellTrade(null)}
                className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs transition"
              >
                Keep Open
              </button>
              <button
                type="button"
                disabled={actionLoading}
                onClick={() => handleConfirmSell(confirmSellTrade)}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs shadow-lg shadow-rose-600/25 transition disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {actionLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <TrendingDown className="h-4 w-4" />}
                CONFIRM EXIT
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-800/80 py-4 px-6 text-center text-xs text-slate-500 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span>MicanyTradx Engine v1.0.0</span>
          <span>•</span>
          <span>Binance Spot Kline (15m)</span>
        </div>
        <div>
          <span>Target API: <code className="text-slate-400 font-mono">{apiUrl}</code></span>
        </div>
      </footer>
    </div>
  );
}
