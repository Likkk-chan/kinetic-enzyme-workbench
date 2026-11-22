# Scientific engine regression checks; run after sourcing dist/engine.R.
# Ordinary R:
# Rscript -e "source('dist/engine.R'); source('tests/science-regression.R')"
# The same source can be evaluated by webR without external R packages.

ed_run_science_tests <- function() {
  count <- 0L
  check <- function(ok, label) {
    if (!isTRUE(ok)) stop(paste("Scientific regression failed:", label), call. = FALSE)
    count <<- count + 1L
  }
  close <- function(actual, expected, tolerance = 1e-6) {
    all(is.finite(actual)) && all(is.finite(expected)) &&
      max(abs(actual - expected) / pmax(abs(expected), 1)) < tolerance
  }
  extract_numbers <- function(json, key) {
    pattern <- paste0('"', key, '":[-+0-9.eE]+')
    matches <- regmatches(json, gregexpr(pattern, json, perl = TRUE))[[1L]]
    as.numeric(sub(paste0('^"', key, '":'), '', matches))
  }
  p <- c(Vmax = 100, Km = 20, Ki = 10, Kis = 10, Kii = 40)
  check(close(ed_predict("competitive", p, 80, 10), 200 / 3), "competitive analytical value")
  check(close(ed_predict("uncompetitive", p, 80, 10), 400 / 9), "uncompetitive analytical value")
  check(close(ed_predict("noncompetitive", p, 80, 10), 40), "noncompetitive analytical value")
  check(close(ed_predict("mixed", p, 20, 20), 200 / 9), "mixed analytical value")

  ss <- c(2, 10, 35, 100, 320)
  ii <- c(0, 5, 20, 60, 180)
  for (model in names(ed_model_names)) {
    par <- p[ed_parameter_names(model)]
    analytic <- ed_log_jacobian(model, par, ss, ii)
    numeric <- sapply(seq_along(par), function(j) {
      h <- 1e-6
      upper <- lower <- log(par)
      upper[j] <- upper[j] + h
      lower[j] <- lower[j] - h
      (ed_predict(model, exp(upper), ss, ii) - ed_predict(model, exp(lower), ss, ii)) / (2 * h)
    })
    check(close(as.numeric(analytic), as.numeric(numeric), 1e-5),
          paste(model, "analytic log-parameter Jacobian vs central differences"))
    check(close(ed_predict(model, par, par[["Km"]], 0), par[["Vmax"]] / 2),
          paste(model, "zero-inhibitor half-maximum limit"))
  }

  # A broad concentration matrix with deterministic, approximately constant-
  # scale noise. Replicates vary but no random generator is needed by this test.
  d <- expand.grid(S = c(2, 5, 10, 20, 40, 80, 160, 320), I = c(0, 5, 20, 60), rep = 1:3)
  truth <- c(Vmax = 120, Km = 35, Kis = 12, Kii = 65)
  d$v <- ed_predict("mixed", truth, d$S, d$I) + .4 * sin(seq_len(nrow(d)) * 1.71)
  d$rep <- NULL
  d <- d[c("S", "I", "v")]
  sf <- 1e-6
  inf <- 1e-9
  vf <- 1e-9
  scaled <- transform(d, S = S * sf, I = I * inf, v = v * vf)
  base_fit <- ed_fit(d, "mixed")
  scaled_fit <- ed_fit(scaled, "mixed")
  transform_parameters <- c(Vmax = vf, Km = sf, Kis = inf, Kii = inf)
  recovered <- unlist(scaled_fit$params) / transform_parameters
  check(close(recovered, unlist(base_fit$params), .005), "parameter recovery is invariant to units")
  check(base_fit$k == base_fit$p + 1L, "AICc counts residual variance")
  expected_aicc <- base_fit$aic + 2 * base_fit$k * (base_fit$k + 1) /
    (nrow(d) - base_fit$k - 1)
  check(close(base_fit$aicc, expected_aicc), "small-sample AICc correction")
  expected_shift <- 2 * nrow(d) * log(vf)
  check(abs((scaled_fit$aicc - base_fit$aicc) - expected_shift) < .01,
        "AICc changes only by the common likelihood scale constant")
  check(close(unlist(scaled_fit$predictions) / vf, unlist(base_fit$predictions), .001),
        "predicted rates are invariant to units")
  if (isTRUE(base_fit$identifiable) && isTRUE(scaled_fit$identifiable)) {
    for (name in names(transform_parameters)) {
      check(close(unlist(scaled_fit$ci[[name]]) / transform_parameters[[name]],
                  unlist(base_fit$ci[[name]]), .01), paste(name, "local interval transforms with units"))
    }
  }

  csv <- paste(capture.output(write.csv(d, row.names = FALSE)), collapse = "\n")
  scaled_csv <- paste(capture.output(write.csv(scaled, row.names = FALSE)), collapse = "\n")
  normal <- ed_analyze(csv, s_min = 2, s_max = 320, i_max = 60)
  tiny_units <- ed_analyze(scaled_csv, s_min = 2 * sf, s_max = 320 * sf, i_max = 60 * inf)
  check(extract_numbers(normal, "candidateCount") > 0, "normal-units design grid is not empty")
  check(identical(extract_numbers(normal, "candidateCount"), extract_numbers(tiny_units, "candidateCount")),
        "tiny-unit concentration values do not erase the design grid")
  check(close(extract_numbers(tiny_units, "score"), extract_numbers(normal, "score"), .005),
        "design disagreement scores are invariant to units")
  check(identical(extract_numbers(normal, "testN"), 18), "holdout retains all three replicates of six conditions")
  check(identical(extract_numbers(normal, "trainN"), 78), "holdout training set has 26 complete conditions")

  invalid <- d
  invalid$S[1L] <- 0
  invalid_csv <- paste(capture.output(write.csv(invalid, row.names = FALSE)), collapse = "\n")
  message <- tryCatch({ ed_analyze(invalid_csv); "not rejected" }, error = function(e) conditionMessage(e))
  check(grepl("Invalid data", message, fixed = TRUE), "invalid input is explicitly rejected")
  cat("PASS:", count, "scientific R regression checks.\n")
  invisible(list(checks = count, baseParameters = base_fit$params,
                 unitRescaledParameters = as.list(recovered),
                 normalCandidateCount = extract_numbers(normal, "candidateCount"),
                 scaledCandidateCount = extract_numbers(tiny_units, "candidateCount")))
}

ed_run_science_tests()
