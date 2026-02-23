$BACKEND_URL="https://products-19199890157.us-east1.run.app"
$TOKEN=$(gcloud auth print-identity-token --audiences="${BACKEND_URL}" --impersonate-service-account="${SA}")
echo $TOKEN