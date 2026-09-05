#!/usr/bin/env python3
"""Generate the public US school-country registry from NCES IPEDS HD2024.

Usage:
  python3 scripts/generate-school-country-registry-data.py \
    --input /path/to/HD2024.csv \
    --reviewed-aliases api/applicants/_lib/school-country-reviewed-aliases.json \
    --output api/applicants/_lib/school-country-registry-data.json

The script uses only Python's standard library and does not download data.
"""
import argparse
import csv
import hashlib
import json
import re
import unicodedata
from pathlib import Path

STATES_AND_DC = {
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
}

def normalize(value):
    value = unicodedata.normalize('NFKD', str(value or ''))
    # Remove combining accents without dropping punctuation first: an en dash
    # must remain long enough for the punctuation fold below to become a space,
    # not concatenate `Rutgers–New` into `rutgersnew`.
    value = ''.join(char for char in value if not unicodedata.combining(char))
    value = value.lower().replace('&', ' and ')
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', value).split())

def whole_aliases(value):
    # HD2024 uses semicolons and runs of two or more spaces between aliases.
    # A comma may be part of an individual official name, so it is never a
    # delimiter.
    return [normalized for item in re.split(r'\s*;\s*|\s{2,}', str(value or '')) if (normalized := normalize(item))]

def activity_status(code):
    return 'active' if code == 'A' else 'historical_or_other'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, type=Path, help='Downloaded NCES HD2024.csv')
    parser.add_argument('--reviewed-aliases', required=True, type=Path, help='Reviewed public country-only alias JSON')
    parser.add_argument('--output', required=True, type=Path, help='Generated public registry JSON')
    args = parser.parse_args()

    raw_bytes = args.input.read_bytes()
    with args.input.open(encoding='utf-8-sig', newline='') as handle:
        source_rows = csv.DictReader(handle)
        institutions = []
        for row in source_rows:
            state = row['STABBR'].strip()
            # Historical institutions remain evidence of a historical US
            # education. Their IPEDS activity status is surfaced separately;
            # it never says anything about accreditation or degree completion.
            if state not in STATES_AND_DC:
                continue
            name = ' '.join(row['INSTNM'].split())
            if not name:
                continue
            institutions.append({
                'unitid': row['UNITID'].strip(),
                'name': name,
                'nameNormalized': normalize(name),
                'state': state,
                'website': row['WEBADDR'].strip() or None,
                'ipedsActivityStatus': activity_status(row['ACT'].strip()),
                'aliasesNormalized': whole_aliases(row.get('IALIAS')),
            })
    institutions.sort(key=lambda row: (row['unitid'], row['nameNormalized']))

    reviewed = json.loads(args.reviewed_aliases.read_text())['aliases']
    country_only_aliases = [{
        'name': item['literalSchool'],
        'nameNormalized': normalize(item['literalSchool']),
        'sourceURL': item['officialEvidenceUrl'],
        'evidence': item['officialEvidence'],
        'reviewedAt': item['reviewedAt'],
    } for item in reviewed]
    country_only_aliases.sort(key=lambda item: item['nameNormalized'])

    data = {
        'schemaVersion': 2,
        'provenance': {
            'source': 'NCES IPEDS HD2024 Directory information',
            'sourceURL': 'https://nces.ed.gov/ipeds/datacenter/data/HD2024.zip',
            'dataFile': args.input.name,
            'fileSha256': hashlib.sha256(raw_bytes).hexdigest(),
            'fileLastModified': '2025-09-21T20:40:58Z',
            'selection': 'All IPEDS HD2024 institutions in the 50 states or District of Columbia, including non-active historical rows. Territories and freely associated areas are deliberately excluded pending a separate policy decision.',
            'normalization': 'NFKD accent folding, case folding, punctuation folding, ampersand to and, and whitespace collapse. Every word and parenthetical content remains.',
        },
        'institutions': institutions,
        'reviewedCountryOnlyAliases': country_only_aliases,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({
        'institutions': len(institutions),
        'reviewedCountryOnlyAliases': len(country_only_aliases),
        'bytes': args.output.stat().st_size,
        'sourceSha256': data['provenance']['fileSha256'],
    }))

if __name__ == '__main__':
    main()
