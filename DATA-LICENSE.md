# Tariff data licence

The tariff dataset in this project — including the master workbook, the source
CSV, the derived `hsn.json`, `fta.json`, `meta.json` and `seed.sql` files, and
the rate data returned by the API — is proprietary. It is **not** covered by the
MIT licence that applies to the application source code.

Copyright (c) 2026 CustomsCalc. All rights reserved.

## What you may do

- Use individual duty rates and calculation results in your own import costing,
  quotations and Bill of Entry preparation.
- Query the public API within your plan's quota and use the responses inside your
  own application.
- Store a small number of results for your own records.

## What you may not do

- Copy, publish, redistribute, resell, sublicense or make available the dataset
  in bulk, whether as JSON, CSV, SQL, a database dump or an API mirror.
- Use the dataset to build, train or populate a competing tariff or duty
  calculator.
- Scrape, harvest or systematically extract the dataset or API responses.
- Remove copyright, source or verification notices from the data.

## Source material

The underlying rates are derived from public Government of India sources,
including CBIC working-tariff publications, customs notifications and GST rate
schedules. Those public sources remain subject to their own terms. The curated
selection, normalisation, FTA modelling, verification flags and derived schema
are the proprietary work of CustomsCalc.

## No warranty

The data is indicative and may contain errors, approximations or omissions. It is
provided without warranty of any kind. Verify every rate on ICEGATE before filing
a Bill of Entry. See the [terms of use](https://customs.vijayebhava.com/terms/).

## Permission requests

For a data licence, bulk access or an enterprise arrangement, contact
<data@vijayebhava.com>.
