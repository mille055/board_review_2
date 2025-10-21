#!/bin/bash

export AWS_PROFILE=cm_boards
BUCKET="cm-boards-cases"

# Path to your local images directory
LOCAL_IMAGES_DIR="../frontend/data/images"

if [ ! -d "$LOCAL_IMAGES_DIR" ]; then
    echo "Error: Images directory not found: $LOCAL_IMAGES_DIR"
    echo "Update LOCAL_IMAGES_DIR in the script to point to your images folder"
    exit 1
fi

echo "=== Uploading Cases to S3 ==="
echo ""

# Case gi-001
echo "Uploading gi-001..."
aws s3 cp "$LOCAL_IMAGES_DIR/gi_appendix_5.png" s3://$BUCKET/cases/gi-001/image-1.png --content-type image/png --cache-control max-age=31536000
aws s3 cp "$LOCAL_IMAGES_DIR/gi_appendix_3.png" s3://$BUCKET/cases/gi-001/image-2.png --content-type image/png --cache-control max-age=31536000
aws s3 cp "$LOCAL_IMAGES_DIR/gi_appendix_4.png" s3://$BUCKET/cases/gi-001/image-3.png --content-type image/png --cache-control max-age=31536000

# Case thorax-002
echo "Uploading thorax-002..."
aws s3 cp "$LOCAL_IMAGES_DIR/thorax_rllcollapse_1.png" s3://$BUCKET/cases/thorax-002/image-1.png --content-type image/png --cache-control max-age=31536000

# Case msk-003
echo "Uploading msk-003..."
aws s3 cp "$LOCAL_IMAGES_DIR/msk_knee_1.png" s3://$BUCKET/cases/msk-003/image-1.png --content-type image/png --cache-control max-age=31536000
aws s3 cp "$LOCAL_IMAGES_DIR/msk_knee_2.png" s3://$BUCKET/cases/msk-003/image-2.png --content-type image/png --cache-control max-age=31536000

# Case us-001
echo "Uploading us-001..."
aws s3 cp "$LOCAL_IMAGES_DIR/gu_nephrocalcinosis_1.png" s3://$BUCKET/cases/us-001/image-1.png --content-type image/png --cache-control max-age=31536000
aws s3 cp "$LOCAL_IMAGES_DIR/gu_nephrocalcinosis_2.png" s3://$BUCKET/cases/us-001/image-2.png --content-type image/png --cache-control max-age=31536000

# Case us-002
echo "Uploading us-002..."
aws s3 cp "$LOCAL_IMAGES_DIR/us_epididymitis_1.png" s3://$BUCKET/cases/us-002/image-1.png --content-type image/png --cache-control max-age=31536000
aws s3 cp "$LOCAL_IMAGES_DIR/us_epididymitis_2.png" s3://$BUCKET/cases/us-002/image-2.png --content-type image/png --cache-control max-age=31536000
aws s3 cp "$LOCAL_IMAGES_DIR/us_epididymitis_3.png" s3://$BUCKET/cases/us-002/image-3.png --content-type image/png --cache-control max-age=31536000
aws s3 cp "$LOCAL_IMAGES_DIR/us_epididymitis_4.png" s3://$BUCKET/cases/us-002/image-4.png --content-type image/png --cache-control max-age=31536000
aws s3 cp "$LOCAL_IMAGES_DIR/us_epididymitis_5.png" s3://$BUCKET/cases/us-002/image-5.png --content-type image/png --cache-control max-age=31536000

# Case us_adenomyosis_001 (includes video!)
echo "Uploading us_adenomyosis_001..."
aws s3 cp "$LOCAL_IMAGES_DIR/us_adenomyosis_0001.png" s3://$BUCKET/cases/us_adenomyosis_001/image-1.png --content-type image/png --cache-control max-age=31536000
aws s3 cp "$LOCAL_IMAGES_DIR/us_adenomyosis_cine.mp4" s3://$BUCKET/cases/us_adenomyosis_001/cine.mp4 --content-type video/mp4 --cache-control max-age=31536000

echo ""
echo "✓ All cases uploaded!"
echo ""
echo "Verify uploads:"
echo "  aws s3 ls s3://$BUCKET/cases/ --recursive --human-readable"
