#!/bin/bash
set -euo pipefail

# --- Configuration ---
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/github-agent"

echo "=== Step 1: Deploy CDK stack ==="
cd infra
npm install
npx cdk deploy --require-approval never --outputs-file ../cdk-outputs.json
cd ..

echo ""
echo "=== Step 2: Build & push Docker image ==="
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

cd agent
npm install
docker build --platform linux/amd64 -t github-agent .
docker tag github-agent:latest "$ECR_REPO:latest"
docker push "$ECR_REPO:latest"
cd ..

echo ""
echo "=== Step 3: Set secrets ==="
echo "Update these SSM parameters with real values:"
echo "  aws ssm put-parameter --name /github-agent/GITHUB_TOKEN --value 'ghp_xxx' --type String --overwrite"
echo "  aws ssm put-parameter --name /github-agent/GITHUB_WEBHOOK_SECRET --value 'your-webhook-secret' --type String --overwrite"
echo "  aws ssm put-parameter --name /github-agent/OPENROUTER_API_KEY --value 'sk-or-xxx' --type String --overwrite"
echo ""

echo "=== Step 4: Configure GitHub webhook ==="
WEBHOOK_URL=$(cat cdk-outputs.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(list(d.values())[0]['WebhookUrl'])" 2>/dev/null || echo "CHECK cdk-outputs.json")
echo "  URL: $WEBHOOK_URL"
echo "  Content type: application/json"
echo "  Secret: (same as GITHUB_WEBHOOK_SECRET)"
echo "  Events: Issues, Pull requests"
echo ""
echo "=== Done! ==="
echo "Add an 'agent' label to any issue or PR to trigger the agent."
