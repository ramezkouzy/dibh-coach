# Paper draft

A Research Letter draft for *Advances in Radiation Oncology*, modeled on
Capaldi et al. 2026 (the iSGRT paper at https://doi.org/10.1016/j.adro.2025.101970).

## Build

Requires a TeX distribution with `elsarticle.cls` (any modern TeX Live or MacTeX has it).

```bash
cd app/paper
pdflatex main && bibtex main && pdflatex main && pdflatex main
```

## Status

Draft. Open items:

- **Author order and affiliations.** Currently a placeholder. Mitchell
  is the natural senior author; Vranich's role (co-author vs.
  acknowledgement vs. supplement) is open. A Capaldi collaboration
  (UCSF) would change author order again; see `../TODO.md`.
- **Results section is preliminary.** Two recordings from one subject
  is enough to motivate the design but not enough to claim feasibility
  in a publication. The full Results section gets rewritten once the
  MDACC IRB pilot (also in TODO) yields N=30+ patients.
- **Figures.** None yet. Likely needs:
    1. Screen-shot composite of the four phases (Welcome / Placement /
       Calibration / Learn / Practice / Complete).
    2. Sample trace of one belly-mode and one chest-mode hold,
       annotated with the algorithm's lock/drift events.
    3. Bland-Altman or correlation plot vs. simulator-day plateau
       (requires the IRB pilot first).
- **Disclosures.** Need to check whether Tide-as-built ever used any
  external collaborator's IP. The pre-recorded TTS pipeline uses
  ElevenLabs models; the lab analyzer is original.
- **References.** `refs.bib` contains the entries the draft cites.
  Mitchell 2025's DOI / volume info needs filling in once we have the
  print citation (currently using the ScienceDirect PII).

## Suggested journal targets in order

1. **Advances in Radiation Oncology** — open access, friendly to
   technical notes / research letters, high relevance to the readership
   (Capaldi 2026 published here).
2. **Practical Radiation Oncology** — Mitchell is an Associate Editor on
   the Breast Track; if anyone, she'd know how this would land.
3. **Technical Innovations & Patient Support in Radiation Oncology** —
   for the patient-engagement angle, especially after IRB validation.
