import re

with open(r"C:\Users\quit\Desktop\sentinel\bags_hackathon.html", encoding="utf-8") as f:
    content = f.read()

print("Content length:", len(content))

# Look for API patterns
api_matches = re.findall(r'["\x27](/api/[^"\x27\s<>]+)["\x27`]', content)
print("\nAPI paths found:", api_matches[:20])

# Look for fetch/supabase/graphql patterns
fetch_matches = re.findall(r"(supabase|graphql|trpc|\.json|/api/)", content)
print("\nData access patterns:", list(set(fetch_matches)))

# Extract app UUIDs
app_links = re.findall(r"/apps/([a-f0-9-]{36})", content)
unique_apps = list(dict.fromkeys(app_links))
print(f"\nUnique app UUIDs found: {len(unique_apps)}")
for app in unique_apps:
    print(" ", app)
