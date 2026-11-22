# Evaluation

KINETIC met my main objective of comparing enzyme inhibition models, explaining uncertainty and suggesting further measurements. I based this evaluation on the recorded development tests and browser checks. The simulated datasets test computational performance under known conditions. Applying the app to laboratory measurements would require separate validation.

## What worked

The app ran R in the browser, imported data, fitted four models, displayed curves and residuals and exported the results. In the main example, **96 observations across 32 substrate–inhibitor concentration pairs** favored the mixed model. The next-best model had **ΔAICc = 104.12**. The fitted values were Vmax = 120.701, Km = 36.654, Kis = 13.251 and Kii = 59.274. [Example report](examples/example-report.html) · [Exported R script](examples/example-analysis.R) · [Results screenshot](screenshots/results-screen.jpg)

Independent checks measured recovery of known parameters and reproducibility of the exported calculations.

| Recorded test | Result |
|---|---|
| Analytical values, limiting cases and reference-data checks | 144 checks passed. |
| Actual-R API suite | 71 checks passed, including execution of a separate 27-check numerical regression. |
| Model recovery | All eight reference datasets with and without noise ranked their generating model first. Maximum relative parameter error was below `1.3e-9` without noise and 6.70% with noise. |
| Export reproducibility | Six checks passed when the downloaded R script ran in a fresh webR instance. Data, model ordering, parameters, AICc, errors and proposed experiments matched the report. The stored parameter difference was zero. |

The detailed evidence is in the [engine-test results](tests/engine-test-results.json), [export-test results](tests/export-test-results.json) and [separate generating parameters](data/ground-truth.json). The reference formulas and fixtures were generated independently of the R fitting code.

The browser checks also confirmed useful behavior beyond numerical fitting. Importing the competitive fixture ranked Competitive first. The seed-42 blind challenge generated Noncompetitive data, and the revealed answer matched the leading model. Invalid negative-inhibitor input was rejected and report export disabled. CSV, report and R downloads worked, and the CSV retained all 96 observations. Model selection updated the parameter and residual displays. The narrow-screen check showed no horizontal overflow. These observations are recorded in the [browser checks](tests/browser-checks.json). The public hosted app was also confirmed accessible without sign-in during delivery.

## What needed correction or remains limited

An early implementation used fixed numeric tolerances that could treat distinct molar-scale concentrations as identical. The implementation switched to relative tolerances and rate scaling. The unit-rescaling tests then passed.

The app appropriately avoided an unqualified strong mechanism claim for weak or absent inhibition. Even when a model ranked first, discrimination could remain tentative. AICc only compares the supplied models under the assumed independent, constant-variance error model. The approximate confidence intervals and single grouped holdout split do not capture every source of uncertainty.

The experiment suggestions respected the specified concentration bounds and excluded measured pairs. The score ranks disagreement between the two leading models. Parameter uncertainty, experimental cost and assay feasibility require separate judgement.

The main remaining limitation is the lack of validation on real laboratory data. Time-dependent inhibition, tight binding, cooperativity, background errors and assay interference could produce behavior outside the four models. Initial-rate measurements, suitable controls and biochemical knowledge remain necessary before interpreting an experimental mechanism. The browser needs internet access to load webR on the first visit. The recorded interface tests cover desktop and narrow-screen layouts, with no separate Codespaces run or full accessibility audit.

I therefore regard KINETIC as a useful, reproducible tool for comparing hypotheses and planning measurements, with conclusions that remain conditional on the data quality and model assumptions.
