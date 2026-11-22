# Enzyme Detective -- scientific engine, base R only.
#
# This file is run unchanged in browser-side webR. It can also be sourced by
# ordinary R. All models assume reversible, steady-state inhibition of a
# single-substrate Michaelis--Menten reaction, with background-corrected initial
# rates and independent, homoscedastic Gaussian measurement errors. Model
# preference is conditional on this candidate set; it is not proof of a
# molecular binding mechanism. Time-dependent, tight-binding, partial,
# cooperative and assay-interference effects are outside this candidate set.
#
# Public API:
#   ed_predict(model_id, named_parameters, S, I)
#   ed_analyze(csv_text, s_min = 2, s_max = 200, i_max = 80) -> JSON string
#
# AICc counts residual variance as a fitted parameter: k = p + 1.
# Confidence intervals are local, approximate log-Wald intervals obtained from
# the observed Hessian. They are suppressed when the Hessian or bounds make
# that approximation unreliable. The experiment score is a transparent
# prediction-disagreement heuristic, not a calibrated information-gain score.

ed_model_names <- c(
  competitive = "Competitive",
  uncompetitive = "Uncompetitive",
  noncompetitive = "Noncompetitive",
  mixed = "Mixed"
)

ed_parameter_names <- function(model) {
  if (identical(model, "mixed")) c("Vmax", "Km", "Kis", "Kii")
  else c("Vmax", "Km", "Ki")
}

ed_predict <- function(model, params, S, I) {
  p <- unlist(params, use.names = TRUE)
  if (identical(model, "competitive")) {
    p[["Vmax"]] * S / (p[["Km"]] * (1 + I / p[["Ki"]]) + S)
  } else if (identical(model, "uncompetitive")) {
    p[["Vmax"]] * S / (p[["Km"]] + S * (1 + I / p[["Ki"]]))
  } else if (identical(model, "noncompetitive")) {
    p[["Vmax"]] * S / ((p[["Km"]] + S) * (1 + I / p[["Ki"]]))
  } else if (identical(model, "mixed")) {
    p[["Vmax"]] * S /
      (p[["Km"]] * (1 + I / p[["Kis"]]) + S * (1 + I / p[["Kii"]]))
  } else stop("Unknown inhibition model.", call. = FALSE)
}

# Analytic derivatives with respect to log-positive kinetic parameters improve
# convergence and exact-parameter recovery in noiseless validation examples.
ed_log_jacobian <- function(model, params, S, I) {
  p <- unlist(params, use.names = TRUE)
  v <- as.numeric(ed_predict(model, p, S, I))
  if (model == "mixed") {
    denominator <- p[["Km"]] * (1 + I / p[["Kis"]]) + S * (1 + I / p[["Kii"]])
    j <- cbind(v, -v * p[["Km"]] * (1 + I / p[["Kis"]]) / denominator,
      v * p[["Km"]] * I / p[["Kis"]] / denominator,
      v * S * I / p[["Kii"]] / denominator)
  } else if (model == "competitive") {
    denominator <- p[["Km"]] * (1 + I / p[["Ki"]]) + S
    j <- cbind(v, -v * p[["Km"]] * (1 + I / p[["Ki"]]) / denominator,
      v * p[["Km"]] * I / p[["Ki"]] / denominator)
  } else if (model == "uncompetitive") {
    denominator <- p[["Km"]] + S * (1 + I / p[["Ki"]])
    j <- cbind(v, -v * p[["Km"]] / denominator,
      v * S * I / p[["Ki"]] / denominator)
  } else {
    j <- cbind(v, -v * p[["Km"]] / (p[["Km"]] + S), v * I / (p[["Ki"]] + I))
  }
  colnames(j) <- ed_parameter_names(model)
  j
}

# A small JSON encoder avoids any runtime package installation. Named lists are
# objects; unnamed lists are arrays. Atomic vectors of length one are scalars.
# Non-finite numbers are JSON null, never invalid NaN/Infinity tokens.
ed_json <- function(x) {
  quote_string <- function(s) encodeString(enc2utf8(as.character(s)), quote = '"')
  if (is.null(x)) return("null")
  if (is.data.frame(x)) {
    return(ed_json(lapply(seq_len(nrow(x)), function(i) as.list(x[i, , drop = FALSE]))))
  }
  if (is.list(x)) {
    nm <- names(x)
    if (!is.null(nm) && length(nm) > 0L && all(nzchar(nm))) {
      parts <- vapply(seq_along(x), function(i) {
        paste0(quote_string(nm[[i]]), ":", ed_json(x[[i]]))
      }, character(1))
      return(paste0("{", paste(parts, collapse = ","), "}"))
    }
    return(paste0("[", paste(vapply(x, ed_json, character(1)), collapse = ","), "]"))
  }
  if (length(x) != 1L) return(ed_json(as.list(x)))
  if (is.na(x)) return("null")
  if (is.logical(x)) return(if (x) "true" else "false")
  if (is.numeric(x)) {
    if (!is.finite(x)) return("null")
    return(format(x, digits = 15L, scientific = TRUE, trim = TRUE))
  }
  quote_string(x)
}

ed_fit <- function(d, model, detailed = TRUE) {
  pnames <- ed_parameter_names(model)
  n <- nrow(d)
  p <- length(pnames)
  # Normalize by the observed rate scale without an absolute unit-dependent
  # floor. The all-zero case has no kinetic information; a computational scale
  # of one only keeps its objective finite and does not create evidence.
  response_scale <- max(abs(d$v))
  if (response_scale == 0) response_scale <- 1
  positive_i <- d$I[d$I > 0]
  ki_scale <- if (length(positive_i)) median(positive_i) else 1
  vmax_start <- max(max(d$v), response_scale * 0.2) * 1.3
  km_start <- median(d$S)
  start <- c(Vmax = vmax_start, Km = km_start,
             if (model == "mixed") c(Kis = ki_scale, Kii = ki_scale) else c(Ki = ki_scale))
  lower <- c(Vmax = response_scale * 1e-5, Km = min(d$S) * 1e-5,
             if (model == "mixed") c(Kis = min(positive_i) * 1e-5,
                                    Kii = min(positive_i) * 1e-5)
             else c(Ki = min(positive_i) * 1e-5))
  upper <- c(Vmax = response_scale * 1e5, Km = max(d$S) * 1e5,
             if (model == "mixed") c(Kis = max(positive_i) * 1e5,
                                    Kii = max(positive_i) * 1e5)
             else c(Ki = max(positive_i) * 1e5))
  lower <- log(lower)
  upper <- log(upper)
  objective <- function(z) {
    if (any(!is.finite(z))) return(1e100)
    pr <- ed_predict(model, setNames(exp(z), pnames), d$S, d$I)
    loss <- sum(((d$v - pr) / response_scale)^2)
    if (is.finite(loss)) loss else 1e100
  }
  gradient <- function(z) {
    params <- setNames(exp(z), pnames)
    pr <- as.numeric(ed_predict(model, params, d$S, d$I))
    jac <- ed_log_jacobian(model, params, d$S, d$I)
    as.numeric(2 * crossprod(jac, pr - d$v) / response_scale^2)
  }
  # Deterministic multi-start search reduces dependence on a single initial
  # guess. Bounds are intentionally wide; a boundary estimate is flagged.
  factors <- rbind(
    c(1, 1, 1, 1), c(2, 4, 1, 1), c(1, .25, .25, 4),
    c(2, 1, 4, .25), c(1, 4, 10, 10), c(2, .25, .1, .1),
    c(1, 1, 100, 1), c(1, 1, 1, 100)
  )
  if (!detailed) factors <- factors[c(1, 3, 5), , drop = FALSE]
  candidates <- lapply(seq_len(nrow(factors)), function(j) {
    z <- log(start * factors[j, seq_len(p)])
    z <- pmin(pmax(z, lower + 1e-6), upper - 1e-6)
    tryCatch(optim(z, objective, gr = gradient, method = "L-BFGS-B", lower = lower,
                   upper = upper, control = list(maxit = 800, factr = 100,
                   pgtol = 1e-12)), error = function(e) NULL)
  })
  candidates <- Filter(function(f) !is.null(f) && is.finite(f$value), candidates)
  if (!length(candidates)) return(NULL)
  converged <- Filter(function(f) identical(f$convergence, 0L), candidates)
  pool <- if (length(converged)) converged else candidates
  fit <- pool[[which.min(vapply(pool, function(f) f$value, numeric(1)))]]
  z <- setNames(fit$par, pnames)
  params <- setNames(exp(z), pnames)
  predictions <- as.numeric(ed_predict(model, params, d$S, d$I))
  residuals <- d$v - predictions
  sse <- sum(residuals^2)
  # A common numerical floor gives all models the same finite likelihood when
  # a noiseless simulation is reproduced to floating-point precision.
  sse_floor <- n * response_scale^2 * 1e-14
  likelihood_sse <- max(sse, sse_floor)
  k <- p + 1L
  aic <- n * (log(2 * pi) + 1 + log(likelihood_sse / n)) + 2 * k
  aicc <- if (n > k + 1L) aic + 2 * k * (k + 1) / (n - k - 1) else Inf
  warnings <- character()
  if (fit$convergence != 0L) warnings <- c(warnings, "Optimizer did not report convergence; interpret this fit cautiously.")
  boundary <- (z - lower < .02) | (upper - z < .02)
  if (any(boundary)) warnings <- c(warnings,
    paste0("Estimate near a search bound: ", paste(pnames[boundary], collapse = ", "), "."))
  ci <- setNames(lapply(pnames, function(x) list(NULL, NULL)), pnames)
  identifiable <- FALSE
  condition_number <- Inf
  if (detailed) {
    h <- tryCatch(optimHess(z, objective, gr = gradient), error = function(e) NULL)
    if (!is.null(h) && all(is.finite(h))) {
      ev <- tryCatch(eigen((h + t(h)) / 2, symmetric = TRUE, only.values = TRUE)$values,
                     error = function(e) rep(NA_real_, p))
      if (all(is.finite(ev)) && min(ev) > 0) {
        condition_number <- max(ev) / min(ev)
        identifiable <- condition_number < 1e9 && !any(boundary)
        if (identifiable) {
          covariance <- tryCatch(solve(h) * (2 * likelihood_sse / (n - p) / response_scale^2),
                                 error = function(e) NULL)
          if (!is.null(covariance) && all(is.finite(covariance)) && all(diag(covariance) >= 0)) {
            se <- sqrt(diag(covariance))
            ci <- setNames(lapply(seq_len(p), function(j) {
              unname(as.list(exp(z[j] + c(-1, 1) * 1.96 * se[j])))
            }), pnames)
          } else identifiable <- FALSE
        }
      }
    }
    if (!identifiable) warnings <- c(warnings,
      "Parameters are weakly identified or near a bound; local confidence intervals are unavailable.")
  }
  list(id = model, name = unname(ed_model_names[[model]]), p = p, k = k,
       aicc = aicc, aic = aic, delta = 0, weight = 0,
       rmse = sqrt(sse / n), sse = sse, cvRmse = NULL,
       params = as.list(params), ci = ci,
       ciMethod = "Approximate 95% local log-Wald intervals from the observed Hessian",
       warnings = as.list(unique(warnings)), predictions = as.list(predictions),
       residuals = as.list(as.numeric(residuals)), converged = fit$convergence == 0L,
       identifiable = identifiable, hessianCondition = condition_number,
       numericalFloorUsed = sse <= sse_floor)
}

ed_analyze <- function(csv_text, s_min = 2, s_max = 200, i_max = 80) {
  if (!is.character(csv_text) || length(csv_text) != 1L || !nzchar(trimws(csv_text)))
    stop("Paste or upload a CSV with the columns S, I, v.", call. = FALSE)
  d <- tryCatch(read.csv(text = csv_text, check.names = FALSE, stringsAsFactors = FALSE,
                         strip.white = TRUE, blank.lines.skip = TRUE),
                error = function(e) stop("CSV could not be read. Use a comma-separated file with columns S, I, v.", call. = FALSE))
  names(d) <- trimws(sub("^\ufeff", "", names(d)))
  if (anyDuplicated(names(d))) stop("CSV column names must be unique.", call. = FALSE)
  if (!all(c("S", "I", "v") %in% names(d)))
    stop("Required columns are S (substrate concentration), I (inhibitor concentration), and v (initial rate). Column names are case-sensitive.", call. = FALSE)
  d <- d[, c("S", "I", "v"), drop = FALSE]
  d[] <- lapply(d, function(x) suppressWarnings(as.numeric(as.character(x))))
  invalid <- which(!is.finite(d$S) | !is.finite(d$I) | !is.finite(d$v) | d$S <= 0 | d$I < 0)
  if (length(invalid)) stop(paste0("Invalid data in CSV data row(s) ",
    paste(head(invalid, 8), collapse = ", "), if (length(invalid) > 8) ", ..." else "",
    ". All values must be finite numbers; S must be positive and I must be nonnegative. No rows were silently removed."), call. = FALSE)
  n <- nrow(d)
  if (n < 12L) stop("At least 12 measurements are required for four-model comparison and small-sample AICc.", call. = FALSE)
  if (n > 3000L) stop("This browser analysis accepts at most 3,000 measurements. Use a smaller, representative dataset.", call. = FALSE)
  if (length(unique(d$S)) < 3L || length(unique(d$I)) < 2L)
    stop("Use at least three distinct substrate concentrations and two distinct inhibitor concentrations, including a positive inhibitor concentration.", call. = FALSE)
  bounds <- c(s_min, s_max, i_max)
  if (length(bounds) != 3L || any(!is.finite(bounds)) || s_min <= 0 || s_max <= s_min || i_max <= 0)
    stop("Experiment bounds must satisfy 0 < minimum S < maximum S, and maximum I > 0.", call. = FALSE)
  warnings <- character()
  rate_scale <- max(abs(d$v))
  if (rate_scale == 0) rate_scale <- 1
  if (!any(d$I == 0)) warnings <- c(warnings,
    "No inhibitor-free control is present; baseline Vmax and Km may be less well constrained.")
  if (any(d$v < 0)) warnings <- c(warnings,
    "Negative measured rates were retained. Check background correction and measurement noise.")
  if (length(unique(d$S)) < 5L) warnings <- c(warnings,
    "Fewer than five substrate concentrations are present; mechanism discrimination may be weak.")
  if (length(unique(d$I)) < 3L) warnings <- c(warnings,
    "Only two inhibitor concentrations are present; consider adding more inhibitor levels.")
  fits <- lapply(names(ed_model_names), function(m) ed_fit(d, m))
  failed <- names(ed_model_names)[vapply(fits, is.null, logical(1))]
  fits <- Filter(function(f) !is.null(f) && is.finite(f$aicc), fits)
  if (length(fits) < 2L) stop("Too few candidate models could be fitted reliably. Check the data range and rate variation.", call. = FALSE)
  fits <- fits[order(vapply(fits, function(f) f$aicc, numeric(1)))]
  deltas <- vapply(fits, function(f) f$aicc - fits[[1]]$aicc, numeric(1))
  weights <- exp(-.5 * deltas)
  weights <- weights / sum(weights)
  for (j in seq_along(fits)) {
    fits[[j]]$delta <- deltas[j]
    fits[[j]]$weight <- weights[j]
  }
  if (length(failed)) warnings <- c(warnings,
    paste0("Candidate model(s) failed to fit: ", paste(failed, collapse = ", "), "."))

  # Fixed grouped holdout: every fifth unique (S,I) condition in a sorted grid.
  # Replicates from one condition stay together to prevent replicate leakage.
  # This is one diagnostic split, not repeated or nested cross-validation.
  condition_key <- paste(format(d$S, digits = 15), format(d$I, digits = 15), sep = "|")
  ordered_keys <- unique(condition_key[order(d$S, d$I)])
  test_keys <- ordered_keys[seq_along(ordered_keys) %% 5L == 0L]
  is_test <- condition_key %in% test_keys
  train <- d[!is_test, , drop = FALSE]
  test <- d[is_test, , drop = FALSE]
  holdout_available <- length(ordered_keys) >= 10L && nrow(train) >= 12L && nrow(test) >= 2L &&
    length(unique(train$S)) >= 3L && length(unique(train$I)) >= 2L && any(train$I > 0)
  if (holdout_available) {
    for (j in seq_along(fits)) {
      hf <- ed_fit(train, fits[[j]]$id, detailed = FALSE)
      if (!is.null(hf) && isTRUE(hf$converged)) {
        pr <- ed_predict(hf$id, hf$params, test$S, test$I)
        fits[[j]]$cvRmse <- sqrt(mean((test$v - pr)^2))
      }
    }
  }
  holdout <- list(available = holdout_available,
    trainN = if (holdout_available) nrow(train) else NULL,
    testN = if (holdout_available) nrow(test) else NULL,
    method = "One fixed grouped holdout: every fifth unique (S,I) condition; all replicates stay together.",
    note = if (holdout_available) "Diagnostic only: not repeated cross-validation and not used for AICc ranking."
           else "Not computed: insufficient condition diversity or training measurements after splitting.")

  best <- fits[[1]]
  runner_up <- fits[[2]]
  if (runner_up$delta < 2) {
    status <- "ambiguous"
    headline <- "Current data do not clearly separate the leading models"
    detail <- paste0(best$name, " and ", runner_up$name,
      " differ by less than 2 AICc units. Treat both as plausible explanations within the tested candidate set.")
  } else if (runner_up$delta < 6) {
    status <- "tentative"
    headline <- paste0(best$name, " is tentatively favored")
    detail <- "The leading model has some relative support, but alternative models remain plausible. Additional measurements can test the distinction."
  } else {
    status <- "supported"
    headline <- paste0(best$name, " has stronger relative support")
    detail <- "The leading model is favored over the other tested models. This preference is conditional on the model assumptions and does not establish a molecular binding mechanism."
  }
  if (!best$identifiable || !best$converged) {
    status <- "limited"
    headline <- "Model ranking is limited by weak parameter identification"
    detail <- "A numerical best fit exists, but its parameters are weakly identified or near a search bound. Expand the measured concentration range and inspect residuals before interpreting a mechanism."
  }
  if (best$rmse > .25 * rate_scale) {
    warnings <- c(warnings,
      "The best model has large residual error relative to the observed rate scale. Check model adequacy, controls, and measurement noise.")
    status <- "limited"
  }
  if (any(vapply(fits, function(f) f$numericalFloorUsed, logical(1))))
    warnings <- c(warnings,
      "A common numerical residual-variance floor was used for an effectively noiseless fit; AICc differences near exact fits are numerical diagnostics.")
  if (s_min < min(d$S) || s_max > max(d$S) || i_max > max(d$I) || min(d$I) > 0)
    warnings <- c(warnings,
      "Some proposed experiment conditions extend beyond the measured concentration range; those predictions are extrapolations.")
  warnings <- c(warnings,
    "Assumes independent, constant-variance errors and reversible steady-state single-substrate inhibition. Inspect raw rates, controls, and residuals.")

  # Plot curves at observed inhibitor levels (maximum five representative ones).
  inhibitor_levels <- sort(unique(d$I))
  if (length(inhibitor_levels) > 5L)
    inhibitor_levels <- inhibitor_levels[unique(round(seq(1, length(inhibitor_levels), length.out = 5L)))]
  s_curve <- exp(seq(log(min(d$S)), log(max(d$S)), length.out = 55L))
  curves <- list()
  for (f in fits) for (iv in inhibitor_levels) {
    pr <- ed_predict(f$id, f$params, s_curve, rep(iv, length(s_curve)))
    curves[[length(curves) + 1L]] <- list(model = f$id, I = iv,
      points = lapply(seq_along(s_curve), function(j) list(S = s_curve[j], v = unname(pr[j]))))
  }

  # Candidate design grid: substrate log grid x zero/positive inhibitor grid.
  # Existing pairs are excluded. The score compares the two leading models,
  # standardized by residual noise with a documented 1% rate-scale floor.
  s_grid <- exp(seq(log(s_min), log(s_max), length.out = 17L))
  i_grid <- unique(c(0, exp(seq(log(i_max / 100), log(i_max), length.out = 12L))))
  grid <- expand.grid(S = s_grid, I = i_grid)
  already_tested <- vapply(seq_len(nrow(grid)), function(j) any(
    abs(d$S - grid$S[j]) <= 1e-7 * pmax(abs(d$S), abs(grid$S[j])) &
    abs(d$I - grid$I[j]) <= 1e-7 * pmax(abs(d$I), abs(grid$I[j]))), logical(1))
  grid <- grid[!already_tested, , drop = FALSE]
  pr1 <- ed_predict(best$id, best$params, grid$S, grid$I)
  pr2 <- ed_predict(runner_up$id, runner_up$params, grid$S, grid$I)
  noise_scale <- max(sqrt((best$rmse^2 + runner_up$rmse^2) / 2), .01 * rate_scale)
  score <- abs(pr1 - pr2) / noise_scale
  design_order <- head(order(score, decreasing = TRUE), 8L)
  design <- lapply(design_order, function(j) {
    predictions <- setNames(list(unname(pr1[j]), unname(pr2[j])), c(best$id, runner_up$id))
    list(S = grid$S[j], I = grid$I[j], score = unname(score[j]),
         difference = unname(abs(pr1[j] - pr2[j])), predictions = predictions,
         extrapolation = grid$S[j] < min(d$S) || grid$S[j] > max(d$S) ||
           grid$I[j] < min(d$I) || grid$I[j] > max(d$I))
  })
  design_info <- list(
    models = as.list(c(best$id, runner_up$id)), noiseScale = noise_scale,
    candidateCount = nrow(grid),
    method = "Absolute prediction difference between the two leading models, divided by residual-noise scale (with a 1% observed-rate-scale floor).",
    limitation = "A heuristic screening grid, not a guaranteed optimal experiment. It ignores parameter uncertainty, costs, feasibility and untested mechanisms.",
    runnerUpPlausible = runner_up$delta < 6,
    bounds = list(sMin = s_min, sMax = s_max, iMax = i_max)
  )
  result <- list(
    n = n, conditions = length(ordered_keys),
    substrateLevels = length(unique(d$S)), inhibitorLevels = length(unique(d$I)),
    models = unname(fits), data = d, curves = curves, design = design,
    designInfo = design_info, holdout = holdout,
    diagnostics = list(status = status, headline = headline, detail = detail,
                       warnings = as.list(unique(warnings))),
    assumptions = list(
      likelihood = "Independent Gaussian errors with constant residual variance; unweighted nonlinear least squares.",
      aicc = "k = number of kinetic parameters + 1 residual-variance parameter; smaller AICc is better.",
      weights = "Akaike weights are relative support within the tested candidate set, not probabilities of a molecular mechanism.",
      confidenceIntervals = "Approximate local 95% log-Wald intervals; unavailable for poorly conditioned or boundary fits.",
      scope = "Reversible, steady-state, single-substrate inhibition; initial rates must be background-corrected."
    ),
    engineVersion = "1.0.0", rVersion = as.character(getRversion())
  )
  ed_json(result)
}
