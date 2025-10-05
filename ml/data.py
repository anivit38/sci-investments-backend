import json
import numpy as np
import pandas as pd
from typing import List, Tuple, Dict

FEATURES = [
    "Score","Ts","avgTs",
    "compVolPct","compSentPct","TVolComp","MVolComp",
    "close","volume","ret1"
]
LABEL = "y_up"

def load_dataset(csv_path: str, tickers: List[str] = None) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df = df.dropna(subset=[LABEL])          # need labels
    if tickers:
        df = df[df["ticker"].isin(tickers)]
    # enforce sort per ticker by date
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values(["ticker","date"]).reset_index(drop=True)
    # coerce features numeric (empty strings → NaN → fill later)
    for c in FEATURES:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df

def time_split(df: pd.DataFrame, train_frac=0.7, val_frac=0.15) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    # time-based split across the union (keeps chronological order per ticker)
    cut1 = int(len(df) * train_frac)
    cut2 = int(len(df) * (train_frac + val_frac))
    return df.iloc[:cut1], df.iloc[cut1:cut2], df.iloc[cut2:]

def fit_standardizer(train_df: pd.DataFrame) -> Dict[str, Dict[str, float]]:
    stats = {}
    for c in FEATURES:
        x = train_df[c].replace([np.inf, -np.inf], np.nan).astype(float)
        mu = float(np.nanmean(x))
        sd = float(np.nanstd(x)) if np.nanstd(x) > 1e-12 else 1.0
        stats[c] = {"mean": mu, "std": sd}
    return stats

def apply_standardizer(df: pd.DataFrame, stats: Dict[str, Dict[str, float]]) -> pd.DataFrame:
    out = df.copy()
    for c in FEATURES:
        mu, sd = stats[c]["mean"], stats[c]["std"]
        out[c] = (out[c].astype(float) - mu) / sd
        out[c] = out[c].replace([np.inf, -np.inf], 0).fillna(0)
    return out

def make_sequences(df: pd.DataFrame, seq_len: int = 30) -> Tuple[np.ndarray, np.ndarray]:
    """
    Build sequences per ticker: for each index t, take window [t-seq_len+1 .. t]
    Features at t correspond to label at t (y_up for next day relative to t).
    """
    X_all, y_all = [], []
    for tkr, g in df.groupby("ticker"):
        g = g.reset_index(drop=True)
        # we need at least seq_len rows to form a sequence ending at index t
        feats = g[FEATURES].values.astype(np.float32)
        labels = g[LABEL].values.astype(np.float32)
        for t in range(seq_len - 1, len(g)):
            X_all.append(feats[t-seq_len+1:t+1])     # [seq_len, F]
            y_all.append(labels[t])                  # binary target at t
    X = np.stack(X_all, axis=0) if X_all else np.zeros((0, seq_len, len(FEATURES)), dtype=np.float32)
    y = np.array(y_all, dtype=np.float32)
    return X, y

def save_stats(path: str, stats: Dict):
    with open(path, "w") as f:
        json.dump(stats, f, indent=2)
