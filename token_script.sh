SA="bruno-invoker@soggy-stitches.iam.gserviceaccount.com"
BACKEND_URL="https://us-east1-soggy-stitches.cloudfunctions.net/products"
TOKEN=$(gcloud auth print-identity-token --audiences="${BACKEND_URL}" --impersonate-service-account="${SA}")
echo ${TOKEN}