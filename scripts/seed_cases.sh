#!/bin/bash
# Quick seed script for cases

TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbjA1NUBzcnUub3JnIiwiZXhwIjoxNzYxMjQzMzA2fQ.Uo8eo9tuvTTWc6lwrefuVqAEKpUIuD1HFT6dWkaylEA"
API_BASE="https://e6x8kt8qvp.us-east-1.awsapprunner.com"

echo "Seeding cases from cases.json..."
echo ""

# Export so Python can access them
export TOKEN
export API_BASE

# Read cases.json and POST each one
python3 <<'EOF'
import json
import requests
import os

# Get variables from environment
TOKEN = os.environ.get('TOKEN')
API_BASE = os.environ.get('API_BASE')

with open('../frontend/data/cases.json', 'r') as f:
    cases = json.load(f)

headers = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json"
}

for i, case in enumerate(cases, 1):
    payload = {
        "id": case["id"],
        "title": case["title"],
        "subspecialty": case["subspecialty"],
        "tags": case.get("tags", []),
        "images": case.get("images", []),
        "boardPrompt": case.get("boardPrompt"),
        "expectedAnswer": case.get("expectedAnswer"),
        "rubric": case.get("rubric", []),
        "media": case.get("media", []),
        "references": case.get("references", []),
        "mcqs": case.get("mcqs"),
        "differential": case.get("differential")
    }
    
    print(f"[{i}/{len(cases)}] Creating {case['id']}...", end=" ")
    
    try:
        r = requests.post(
            f"{API_BASE}/api/admin/cases",
            json=payload,
            headers=headers
        )
        if r.status_code == 200:
            print("✓")
        else:
            print(f"✗ {r.status_code}: {r.text}")
    except Exception as e:
        print(f"✗ {e}")

print("\nDone!")
EOF