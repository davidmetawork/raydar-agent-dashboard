#!/usr/bin/env python3
"""Generate name-only US-country holds for known non-US ROR collisions.

Usage:
  python3 scripts/generate-school-country-global-collision-holds.py \
    --registry api/applicants/_lib/school-country-registry-data.json \
    --ror /path/to/ror-data.json \
    --output api/applicants/_lib/school-country-global-collision-holds.json

The script consumes downloaded public data only; it makes no network requests.
ROR is a research-organization registry and is incomplete by design. A listed
collision blocks name-only US resolution. An absent collision establishes
nothing about global uniqueness.
"""
import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path


def normalize(value):
    value = unicodedata.normalize('NFKD', str(value or ''))
    value = ''.join(char for char in value if not unicodedata.combining(char))
    value = value.lower().replace('&', ' and ')
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', value).split())


def foreign_countries(record):
    return sorted({
        location.get('geonames_details', {}).get('country_code')
        for location in record.get('locations', [])
        if location.get('geonames_details', {}).get('country_code') not in {None, 'US'}
    })


def websites(record):
    return sorted({link['value'] for link in record.get('links', []) if link.get('type') == 'website' and link.get('value')})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--registry', required=True, type=Path)
    parser.add_argument('--ror', required=True, type=Path, help='Downloaded ROR v2 JSON data dump')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()

    registry = json.loads(args.registry.read_text())
    source_bytes = args.ror.read_bytes()
    ror = json.loads(source_bytes)

    us_candidates = {}
    for institution in registry['institutions']:
        for normalized in [institution['nameNormalized'], *institution['aliasesNormalized']]:
            us_candidates.setdefault(normalized, []).append({
                'kind': 'ipeds_exact_name' if normalized == institution['nameNormalized'] else 'ipeds_whole_alias',
                'unitid': institution['unitid'],
                'name': institution['name'],
                'state': institution['state'],
            })
    for alias in registry['reviewedCountryOnlyAliases']:
        us_candidates.setdefault(alias['nameNormalized'], []).append({
            'kind': 'reviewed_country_only_alias',
            'unitid': None,
            'name': alias['name'],
            'state': None,
        })

    foreign_by_normalized = {}
    for record in ror:
        countries = foreign_countries(record)
        if not countries:
            continue
        # Labels preserve named organizations. Acronyms are deliberately
        # excluded: their collision surface is too broad to be useful evidence.
        for named in record.get('names', []):
            if not ({'label', 'ror_display'} & set(named.get('types', []))):
                continue
            normalized = normalize(named.get('value'))
            if not normalized or normalized not in us_candidates:
                continue
            foreign_by_normalized.setdefault(normalized, {})[record['id']] = {
                'rorId': record['id'],
                'name': named['value'],
                'countryCodes': countries,
                'websites': websites(record),
            }

    holds = []
    for normalized in sorted(foreign_by_normalized):
        candidates = {(row['kind'], row['unitid'], row['name'], row['state']) for row in us_candidates[normalized]}
        holds.append({
            'nameNormalized': normalized,
            'usCandidates': [
                {'kind': kind, 'unitid': unitid, 'name': name, 'state': state}
                for kind, unitid, name, state in sorted(candidates, key=lambda x: (x[0], x[1] or '', x[2]))
            ],
            'foreignOrganizations': list(foreign_by_normalized[normalized].values()),
        })

    data = {
        'schemaVersion': 1,
        'provenance': {
            'source': 'Research Organization Registry (ROR) data dump',
            'sourceURL': 'https://doi.org/10.5281/zenodo.6347574',
            'release': args.ror.name,
            'fileSha256': hashlib.sha256(source_bytes).hexdigest(),
            'selection': 'Non-US ROR records with an exact normalized label or ROR display name matching an IPEDS canonical name, IPEDS whole alias, or reviewed country-only alias. ROR acronyms are excluded from comparison.',
            'interpretation': 'Each listed row is a known global name collision and blocks name-only US resolution. ROR is not an exhaustive global education registry; an absent row does not establish global uniqueness.',
            'normalization': 'NFKD accent folding, case folding, punctuation folding, ampersand to and, and whitespace collapse. Every word and parenthetical content remains.',
        },
        'holds': holds,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps({'holds': len(holds), 'bytes': args.output.stat().st_size, 'sourceSha256': data['provenance']['fileSha256']}))

if __name__ == '__main__':
    main()
