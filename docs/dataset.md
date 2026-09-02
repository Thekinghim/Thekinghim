# MELT — schema

Källa: `github.com/git-disl/melt` @ `0732bcf`. Licens CC BY-NC 4.0.

## Vad som ligger i repot

| Fil | Storlek | Innehåll |
|---|---|---|
| `data/label/label.csv` | 3,7 MB | 41 470 rader — `mint_address, min_ratio, manipulated, return_ratio, label` |
| `data/memecoin/memecoin_list.jsonl` | 13 MB | Tokenlista |
| `data/memecoin/metadata.jsonl` | 12 MB | Metadata per token |
| `data/feat/sol_hourly.txt` | 51 KB | SOL-pris per timme, för USD-normalisering |
| `results/*_pred_*.csv` | 2,4 MB | Testprediktioner per modell: `mint, label, prob` (6 491 rader) |

## Vad som ligger på Google Drive (ej i repot)

| Fil | Krävs för |
|---|---|
| `feature.pkl` | All modellträning. Genvägen förbi `feat_gen.py`. |
| `pre_migration_tx.zip` | Featuregenerering från grunden, och all entitetsupplösning |
| `bundle.zip` | Jito-bundle-heuristiken (heuristik 3) |
| `post_migration_tx.zip` | Egen eftermigrationsanalys. Valfri, mycket stor. |

## Fältbetydelser

- `label` — `high` / `medium` / `low` risk. **I koden blir det `0` för `high`
  och `1` för allt annat.** Positiv klass i AUPRC är alltså icke-högrisk.
- `min_ratio` — lägsta pris som andel av migrationspriset. `< 0,2` för 60,3 %.
- `return_ratio` — avkastning relativt migrationspris. Extremt fettsvansad:
  median −0,68, medel +1759,9.
- `manipulated` — mestadels `unknown` i den publika filen.

## Splitt och prefilter

`dataset.load_dataset` sorterar på `mint_ts`, tar första 70 % som träning och
sista 30 % som test, och shufflar endast träningsdelen. Prefilter:
`group3_time_span_valid >= 60` och `group3_holder_num >= 100`.

Prefiltret körs på feature-kolumner, inte på `label.csv`, och kan därför inte
tillämpas förrän `feature.pkl` finns.
