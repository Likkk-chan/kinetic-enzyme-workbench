# Prompt examples for KINETIC

## 1. Start building

> Build an English web app called KINETIC that compares enzyme inhibition mechanisms. Let users load a synthetic example or upload a CSV with substrate concentration `S`, inhibitor concentration `I` and initial rate `v`. Use R in the browser to fit the competitive, uncompetitive, noncompetitive and mixed models to the same data. Show the observations, fitted curves, residuals, parameters and an AICc comparison. Explain when the data give similar support to multiple models. Suggest a follow-up measurement where the two leading models predict different rates. Display the R source and let users download their results. Start with one example that runs from data import through to the results screen.

## 2. Clarify uncertainty on the results page

> Add an evidence summary above the model ranking. If the two leading models differ by less than 2 AICc units, tell the reader that the data do not clearly distinguish them. Show the ΔAICc values and let the reader switch between the fitted curves and residual plots for each candidate. If the leading model's parameters are poorly constrained, flag the ranking as limited evidence. Explain that the ranking gives relative support among the models tested. Check the revised page with the built-in mixed-inhibition example and a weak-inhibition dataset.

The revised results page pairs the model ranking with an evidence summary and fit diagnostics. A reader can see when the same data are compatible with more than one mechanism.
