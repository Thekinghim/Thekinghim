"""
Testar om en pump.fun-creators tidigare launches förutsäger nästa.

Varför den här frågan: PLAN.md:s H1 säger att entiteten är signalen, inte
walleten. Creator-fältet i MELT är den grövsta möjliga entiteten — en enda
adress, ingen klustring — och därför ett golv. Går det inte att visa någon
signal ens här är H1 i trubbel. Visar den signal är det ett golv som
entitetsupplösning i Fas 1 ska slå.

Punkt-i-tiden-korrekthet (CLAUDE.md regel 1):
  Beslutstidpunkten är den tidpunkt token X lanseras, t_X.
  Features får bara använda creatorns launches med t < t_X − 24 h.
  24-timmarsmarginalen finns för att utfallet (return_ratio) mäts efter
  migration, som sker en okänd tid efter launch. Utan marginalen skulle vi
  kunna använda ett utfall som ännu inte var observerbart vid t_X.

Rapportering (CLAUDE.md regel 3 och 4): median, p25, p75 och träffprocent,
aldrig ett naket medelvärde, och bootstrap på tokennivå.
"""
import argparse
import json
import pathlib
import sys

import numpy as np
import pandas as pd

BUFFER_SECONDS = 24 * 3600


def load(melt_root: pathlib.Path) -> pd.DataFrame:
    rows = []
    with open(melt_root / "data" / "memecoin" / "memecoin_list.jsonl") as f:
        for line in f:
            r = json.loads(line)
            rows.append((r["token_address"], int(r["timestamp"]), r["creator"]))
    launches = pd.DataFrame(rows, columns=["mint_address", "ts", "creator"])

    meta = []
    with open(melt_root / "data" / "memecoin" / "metadata.jsonl") as f:
        for line in f:
            r = json.loads(line)
            meta.append(
                (
                    r["address"],
                    r.get("name") or "",
                    r.get("symbol") or "",
                    bool(r.get("twitter")),
                    bool(r.get("website")),
                    bool(r.get("telegram")),
                )
            )
    metadata = pd.DataFrame(
        meta, columns=["mint_address", "name", "symbol", "has_twitter", "has_website", "has_telegram"]
    )

    labels = pd.read_csv(melt_root / "data" / "label" / "label.csv")

    df = launches.merge(labels, on="mint_address", how="inner").merge(
        metadata, on="mint_address", how="left"
    )
    return df.sort_values("ts", kind="stable").reset_index(drop=True)


def add_prior_creator_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    För varje token: creatorns historik *före* beslutstidpunkten.

    Implementeras som ett enda svep i tidsordning. En creators bidrag läggs
    till i historiken först när dess launch är äldre än bufferten, vilket är
    vad som gör funktionen punkt-i-tiden-korrekt.
    """
    df = df.sort_values("ts", kind="stable").reset_index(drop=True)

    prior_n = np.zeros(len(df), dtype=np.int32)
    prior_nonhigh = np.zeros(len(df), dtype=np.int32)
    prior_best_return = np.full(len(df), np.nan)

    # creator -> lista av (ts, är_icke_high, return_ratio) redan frisläppta
    history = {}
    # Kö av launches som ännu inte passerat bufferten.
    pending = []
    pending_head = 0

    ts_values = df["ts"].values
    creators = df["creator"].values
    is_nonhigh = (df["label"].values != "high").astype(np.int32)
    returns = df["return_ratio"].values

    for i in range(len(df)):
        now = ts_values[i]

        # Släpp in allt som hunnit bli observerbart.
        while pending_head < len(pending) and pending[pending_head][0] + BUFFER_SECONDS <= now:
            ts_p, creator_p, nonhigh_p, ret_p = pending[pending_head]
            pending_head += 1
            entry = history.setdefault(creator_p, {"n": 0, "nonhigh": 0, "best": np.nan})
            entry["n"] += 1
            entry["nonhigh"] += nonhigh_p
            entry["best"] = ret_p if np.isnan(entry["best"]) else max(entry["best"], ret_p)

        entry = history.get(creators[i])
        if entry:
            prior_n[i] = entry["n"]
            prior_nonhigh[i] = entry["nonhigh"]
            prior_best_return[i] = entry["best"]

        pending.append((now, creators[i], is_nonhigh[i], returns[i]))

    df["prior_launches"] = prior_n
    df["prior_nonhigh"] = prior_nonhigh
    df["prior_best_return"] = prior_best_return
    return df


def summarize(v, name, indent=""):
    v = np.asarray(v, dtype=float)
    v = v[np.isfinite(v)]
    if v.size == 0:
        return f"{indent}{name}: inga värden"
    return (
        f"{indent}{name:34} n={v.size:6,}  median={np.median(v):+7.3f}  "
        f"p25={np.percentile(v,25):+7.3f}  p75={np.percentile(v,75):+7.3f}  "
        f"träff={np.mean(v>0)*100:5.1f} %"
    )


def bootstrap_diff(a, b, n_boot=2000, seed=42):
    """
    Skillnad i median mellan två grupper, med percentil-KI.
    Bootstrap sker på tokennivå — varje token är en observation (regel 4).
    """
    rng = np.random.default_rng(seed)
    a = np.asarray(a, float); a = a[np.isfinite(a)]
    b = np.asarray(b, float); b = b[np.isfinite(b)]
    if a.size < 30 or b.size < 30:
        return None
    diffs = np.empty(n_boot)
    for i in range(n_boot):
        diffs[i] = np.median(rng.choice(a, a.size, replace=True)) - np.median(
            rng.choice(b, b.size, replace=True)
        )
    return float(np.median(diffs)), float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--melt", default="/home/user/git-disl/melt")
    args = ap.parse_args()

    df = load(pathlib.Path(args.melt))
    print(f"\n{'='*82}\nCREATOR-RECIDIVISM PÅ RIKTIGA PUMP.FUN-LAUNCHES\n{'='*82}\n")
    print(f"Tokens med både launchdata och label: {len(df):,}")
    print(f"Unika creators: {df['creator'].nunique():,}")

    counts = df.groupby("creator").size()
    print(f"Creators med >1 launch: {(counts > 1).sum():,}  "
          f"({(counts > 1).mean()*100:.1f} % av creators, "
          f"{counts[counts > 1].sum()/len(df)*100:.1f} % av alla launches)")
    print(f"Största creator: {counts.max():,} launches")

    df = add_prior_creator_features(df)

    # ---- Har creatorn historik alls? ------------------------------------
    print(f"\n{'-'*82}\nUTFALL EFTER CREATORNS HISTORIK (punkt-i-tiden, 24 h buffert)\n{'-'*82}")
    first = df[df["prior_launches"] == 0]
    repeat = df[df["prior_launches"] > 0]
    print(f"\nFörstagångs-creator vid beslutstidpunkten: {len(first):,}")
    print(f"Återkommande creator:                      {len(repeat):,}")

    print()
    print(summarize(first["return_ratio"], "return_ratio, förstagång"))
    print(summarize(repeat["return_ratio"], "return_ratio, återkommande"))
    print(f"\n  Andel high-risk, förstagång:    {(first['label']=='high').mean()*100:.1f} %")
    print(f"  Andel high-risk, återkommande:  {(repeat['label']=='high').mean()*100:.1f} %")

    # ---- Har creatorn någonsin gjort en icke-high? ----------------------
    print(f"\n{'-'*82}\nHAR CREATORN TIDIGARE GJORT EN ICKE-HÖGRISK TOKEN?\n{'-'*82}\n")
    clean = repeat[repeat["prior_nonhigh"] > 0]
    dirty = repeat[repeat["prior_nonhigh"] == 0]
    print(summarize(clean["return_ratio"], "har tidigare icke-high"))
    print(summarize(dirty["return_ratio"], "bara high tidigare"))
    print(f"\n  Andel high-risk, har tidigare icke-high: {(clean['label']=='high').mean()*100:.1f} %  (n={len(clean):,})")
    print(f"  Andel high-risk, bara high tidigare:     {(dirty['label']=='high').mean()*100:.1f} %  (n={len(dirty):,})")

    boot = bootstrap_diff(clean["return_ratio"].values, dirty["return_ratio"].values)
    if boot:
        med, lo, hi = boot
        crosses = lo <= 0 <= hi
        print(f"\n  Bootstrap på medianskillnad (tokennivå, 2000 dragningar):")
        print(f"    {med:+.4f}  95 % KI [{lo:+.4f}, {hi:+.4f}]  "
              f"→ {'INGEN signal (KI korsar noll)' if crosses else 'SIGNAL (KI utesluter noll)'}")

    # ---- Socials vid launch --------------------------------------------
    print(f"\n{'-'*82}\nSOCIALS IFYLLDA VID LAUNCH\n{'-'*82}\n")
    df["n_socials"] = df[["has_twitter", "has_website", "has_telegram"]].sum(axis=1)
    for n in sorted(df["n_socials"].unique()):
        sub = df[df["n_socials"] == n]
        print(f"  {n} socials: n={len(sub):6,}  high-risk {(sub['label']=='high').mean()*100:5.1f} %  "
              f"median return {np.median(sub['return_ratio']):+.3f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
