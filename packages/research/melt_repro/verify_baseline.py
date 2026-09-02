"""
Fas 0, steg 1: verifiera den publicerade baslinjen oberoende.

Kör MELT:s egna prediktions-CSV:er mot deras label-fil och räknar om AUPRC
från grunden. Syftet är inte att lita på filnamnen — det är att bevisa att
vår förståelse av deras uppgift (vilken klass som är positiv, vilken
delmängd som är test) stämmer. Gör den inte det är allt nedströms fel.

Kritisk detalj som är lätt att missa: i `dataset.load_dataset` är etiketten
`0 if "high" else 1`. Den positiva klassen i AUPRC är alltså *icke*-högrisk.
Rankar man "efter risk" måste man därför sortera på stigande sannolikhet.

Kör: python packages/research/melt_repro/verify_baseline.py --melt <sökväg>
"""
import argparse
import pathlib
import re
import sys

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score

FILENAME_AUPRC = re.compile(r"_([0-9]\.[0-9]{6})\.csv$")


def summarize(values, name):
    """CLAUDE.md regel 3: aldrig ett naket medelvärde på en fettsvansad fördelning."""
    v = np.asarray(values, dtype=float)
    v = v[np.isfinite(v)]
    if v.size == 0:
        return f"{name}: inga värden"
    return (
        f"{name}: n={v.size}  median={np.median(v):+.4f}  "
        f"p25={np.percentile(v, 25):+.4f}  p75={np.percentile(v, 75):+.4f}  "
        f"träff={np.mean(v > 0):.3f}  medel={np.mean(v):+.4f}"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--melt", default="/home/user/git-disl/melt", help="Sökväg till MELT-repot")
    args = ap.parse_args()

    root = pathlib.Path(args.melt)
    labels = pd.read_csv(root / "data" / "label" / "label.csv")
    results = sorted((root / "results").glob("*_pred_*.csv"))

    print(f"\n{'='*78}\nFAS 0 — VERIFIERING AV PUBLICERAD BASLINJE\n{'='*78}\n")

    # ---- Datasetets form -------------------------------------------------
    print(f"label.csv: {len(labels):,} rader, kolumner {list(labels.columns)}")
    dist = labels["label"].value_counts(normalize=True).sort_index()
    print("\nKlassfördelning i hela datasetet (före prefilter):")
    for name, share in dist.items():
        print(f"  {str(name):10} {share*100:5.1f} %  ({int(share*len(labels)):,})")

    # CLAUDE.md påstår 84,1 % high-risk och 4,5 % low-risk. Prefiltret körs
    # dock på feature-kolumner vi inte har, så siffran här gäller osiktat.
    print("\nCLAUDE.md anger 84,1 % high-risk och 4,5 % low-risk efter prefilter.")

    # ---- AUPRC per modell ------------------------------------------------
    print(f"\n{'-'*78}\nAUPRC — omräknad från prediktionsfilerna\n{'-'*78}")
    print(f"{'modell':10} {'n_test':>7} {'i filnamn':>10} {'omräknad':>10} {'diff':>9}  status")

    recomputed = {}
    for path in results:
        pred = pd.read_csv(path)
        stated = float(FILENAME_AUPRC.search(path.name).group(1))
        got = average_precision_score(pred["label"].values, pred["prob"].values)
        recomputed[path.name] = got
        diff = got - stated
        ok = "OK" if abs(diff) < 1e-6 else "AVVIKER"
        model = path.name.split("_")[0]
        print(f"{model:10} {len(pred):7,} {stated:10.6f} {got:10.6f} {diff:+9.2e}  {ok}")

    best_name = max(recomputed, key=recomputed.get)
    best = recomputed[best_name]
    target, tol = 0.573, 0.03
    within = abs(best - target) <= tol
    print(
        f"\nBästa modell: {best_name.split('_')[0]} med AUPRC {best:.6f}\n"
        f"Fas 0-krav: inom ±{tol} av {target} → {'UPPFYLLT' if within else 'EJ UPPFYLLT'}"
    )

    # ---- Vad prediktionsfilerna säger om utfallet ------------------------
    # label.csv bär `return_ratio` och `min_ratio`. Vi vet ännu inte exakt
    # hur MELT definierar dem — det avgörs i nästa steg mot feat_gen.py.
    print(f"\n{'-'*78}\nUtfallskolumner i label.csv\n{'-'*78}")
    for col in ("return_ratio", "min_ratio"):
        print(summarize(labels[col], col))

    below20 = float((labels["min_ratio"] < 0.2).mean())
    print(
        f"\nAndel med min_ratio < 0,20: {below20*100:.1f} %"
        f"   (CLAUDE.md anger 60,3 % under 20 % av migrationspris inom 20 min)"
    )

    return 0 if within else 1


if __name__ == "__main__":
    sys.exit(main())
