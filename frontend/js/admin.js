import { CONFIG } from './config.js';

// Store uploaded files
let uploadedImages = [];
let uploadedVideos = [];
let uploadedReferences = [];

// Check if user is logged in and is admin
async function checkAdminAccess() {
    const token = localStorage.getItem('jwt');
    if (!token) {
        window.location.href = '/login.html';
        return;
    }

    try {
        const response = await fetch(`${CONFIG.API_BASE}/api/admin/cases`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (response.status === 403) {
            alert('You do not have admin access');
            window.location.href = '/';
            return;
        }
        
        if (!response.ok) {
            throw new Error('Failed to verify admin access');
        }
        
        // Load existing cases for auto-suggestion
        await loadExistingCases();
    } catch (error) {
        console.error('Admin check failed:', error);
        alert('Failed to verify admin access');
        window.location.href = '/';
    }
}

// Load existing cases and suggest next case ID
async function loadExistingCases() {
    try {
        const token = localStorage.getItem('jwt');
        const response = await fetch(`${CONFIG.API_BASE}/api/cases`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!response.ok) return;
        
        const cases = await response.json();
        
        // Count cases per subspecialty
        const counts = {};
        cases.forEach(c => {
            const sub = c.subspecialty || 'Unknown';
            counts[sub] = (counts[sub] || 0) + 1;
        });
        
        // Store for later use
        window.__existingCases = cases;
        window.__caseCounts = counts;
        
        console.log('Loaded cases:', cases.length);
        console.log('Counts by subspecialty:', counts);
    } catch (error) {
        console.error('Failed to load existing cases:', error);
    }
}

// Suggest next case ID based on subspecialty selection
function suggestNextCaseId() {
    const subspecialty = document.getElementById('subspecialty').value;
    if (!subspecialty || !window.__caseCounts) return;
    
    // Map subspecialty to prefix
    const prefixMap = {
        'Gastrointestinal Radiology': 'gi',
        'Thoracic Radiology': 'thorax',
        'Musculoskeletal Radiology': 'msk',
        'Neuroradiology': 'neuro',
        'Ultrasound': 'us',
        'Genitourinary Radiology': 'gu',
        'Breast Imaging': 'breast',
        'Pediatric Radiology': 'peds',
        'Nuclear Medicine': 'nm',
        'Interventional Radiology': 'ir'
    };
    
    const prefix = prefixMap[subspecialty] || 'case';
    const count = window.__caseCounts[subspecialty] || 0;
    const nextNum = String(count + 1).padStart(3, '0');
    const suggestedId = `${prefix}-${nextNum}`;
    
    document.getElementById('caseId').value = suggestedId;
    document.getElementById('title').value = `Case ${count + 1}`;
}

// Upload file to S3
async function uploadFile(file, endpoint, caseId) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('case_id', caseId);

    const token = localStorage.getItem('jwt');
    
    const response = await fetch(`${CONFIG.API_BASE}${endpoint}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`
        },
        body: formData
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.detail || 'Upload failed');
    }

    return await response.json();
}

// Setup image upload
function setupImageUpload() {
    const uploadArea = document.getElementById('imageUploadArea');
    const fileInput = document.getElementById('imageInput');
    const uploadedContainer = document.getElementById('uploadedImages');

    uploadArea.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        await handleImageFiles(files);
        fileInput.value = ''; // Reset for re-upload
    });

    // Drag and drop
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        await handleImageFiles(files);
    });
}

async function handleImageFiles(files) {
    const caseId = document.getElementById('caseId').value;
    if (!caseId) {
        alert('Please enter a Case ID first');
        return;
    }

    const uploadedContainer = document.getElementById('uploadedImages');
    
    for (const file of files) {
        // Show uploading state
        const tempDiv = document.createElement('div');
        tempDiv.className = 'uploaded-file';
        tempDiv.innerHTML = `<span>Uploading ${file.name}...</span>`;
        uploadedContainer.appendChild(tempDiv);

        try {
            const result = await uploadFile(file, '/api/admin/upload-image', caseId);
            
            // Remove temp div
            uploadedContainer.removeChild(tempDiv);
            
            // Add to uploaded images
            uploadedImages.push(result.url);
            
            // Show uploaded file
            const fileDiv = document.createElement('div');
            fileDiv.className = 'uploaded-file';
            fileDiv.innerHTML = `
                <div style="display: flex; align-items: center; flex: 1;">
                    <img src="${result.url}" alt="${result.filename}" crossorigin="anonymous">
                    <span>${result.filename}</span>
                </div>
                <button type="button" class="btn ghost btn-sm" onclick="removeImage('${result.url}')">Remove</button>
            `;
            uploadedContainer.appendChild(fileDiv);
            
        } catch (error) {
            uploadedContainer.removeChild(tempDiv);
            alert(`Failed to upload ${file.name}: ${error.message}`);
        }
    }
}

// Setup video upload (similar to images)
function setupVideoUpload() {
    const uploadArea = document.getElementById('videoUploadArea');
    const fileInput = document.getElementById('videoInput');
    const uploadedContainer = document.getElementById('uploadedVideos');

    uploadArea.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', async (e) => {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            const caseId = document.getElementById('caseId').value;
            
            if (!caseId) {
                alert('Please enter a Case ID first');
                return;
            }

            try {
                const result = await uploadFile(file, '/api/admin/upload-video', caseId);
                uploadedVideos.push(result.url);
                
                const fileDiv = document.createElement('div');
                fileDiv.className = 'uploaded-file';
                fileDiv.innerHTML = `
                    <span>📹 ${result.filename}</span>
                    <button type="button" class="btn ghost btn-sm" onclick="removeVideo('${result.url}')">Remove</button>
                `;
                uploadedContainer.appendChild(fileDiv);
            } catch (error) {
                alert(`Failed to upload video: ${error.message}`);
            }
        }
        fileInput.value = '';
    });
}

// Setup reference upload
function setupReferenceUpload() {
    const uploadArea = document.getElementById('referenceUploadArea');
    const fileInput = document.getElementById('referenceInput');
    const uploadedContainer = document.getElementById('uploadedReferences');

    uploadArea.addEventListener('click', () => fileInput.click());
    
    fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        const caseId = document.getElementById('caseId').value;
        
        if (!caseId) {
            alert('Please enter a Case ID first');
            return;
        }

        for (const file of files) {
            try {
                const result = await uploadFile(file, '/api/admin/upload-reference', caseId);
                
                uploadedReferences.push({
                    title: file.name.replace('.pdf', ''),
                    type: 'pdf',
                    url: result.url
                });
                
                const fileDiv = document.createElement('div');
                fileDiv.className = 'uploaded-file';
                fileDiv.innerHTML = `
                    <span>📄 ${result.filename}</span>
                    <button type="button" class="btn ghost btn-sm" onclick="removeReference('${result.url}')">Remove</button>
                `;
                uploadedContainer.appendChild(fileDiv);
            } catch (error) {
                alert(`Failed to upload ${file.name}: ${error.message}`);
            }
        }
        fileInput.value = '';
    });
}

// Remove functions (make global)
window.removeImage = function(url) {
    uploadedImages = uploadedImages.filter(u => u !== url);
    refreshUploadedFiles();
}

window.removeVideo = function(url) {
    uploadedVideos = uploadedVideos.filter(u => u !== url);
    refreshUploadedFiles();
}

window.removeReference = function(url) {
    uploadedReferences = uploadedReferences.filter(r => r.url !== url);
    refreshUploadedFiles();
}

function refreshUploadedFiles() {
    // Re-render all uploaded files lists
    document.getElementById('uploadedImages').innerHTML = '';
    document.getElementById('uploadedVideos').innerHTML = '';
    document.getElementById('uploadedReferences').innerHTML = '';
    
    // Re-add each file (you'd need to store more metadata to fully re-render)
    // For now, users just need to re-upload if they remove by mistake
}

// Rubric management
function addRubricPoint() {
    const list = document.getElementById('rubricList');
    const li = document.createElement('li');
    li.className = 'rubric-item';
    li.innerHTML = `
        <input type="text" placeholder="Rubric point" class="rubric-point">
        <button type="button" class="btn ghost" onclick="this.parentElement.remove()">Remove</button>
    `;
    list.appendChild(li);
}

// Form submission
async function submitCase(e) {
    e.preventDefault();

    if (uploadedImages.length === 0) {
        alert('Please upload at least one image');
        return;
    }

    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';

    try {
        // Collect rubric points
        const rubricPoints = Array.from(document.querySelectorAll('.rubric-point'))
            .map(input => input.value.trim())
            .filter(v => v);

        if (rubricPoints.length === 0) {
            alert('Please add at least one rubric point');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create Case';
            return;
        }

        // Build case object
        const caseData = {
            id: document.getElementById('caseId').value.trim(),
            title: document.getElementById('title').value.trim(),
            subspecialty: document.getElementById('subspecialty').value,
            tags: document.getElementById('tags').value.split(',').map(t => t.trim()).filter(t => t),
            images: uploadedImages,
            boardPrompt: document.getElementById('boardPrompt').value.trim(),
            expectedAnswer: document.getElementById('expectedAnswer').value.trim(),
            rubric: rubricPoints,
            references: uploadedReferences
        };

        // Add videos if any
        if (uploadedVideos.length > 0) {
            caseData.media = uploadedVideos.map(url => ({
                type: 'video',
                src: url,
                autoplay: true,
                loop: true,
                muted: true
            }));
        }

        // Submit to backend
        const token = localStorage.getItem('jwt');
        const response = await fetch(`${CONFIG.API_BASE}/api/admin/cases`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(caseData)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to create case');
        }

        const result = await response.json();
        
        // Show success message
        showStatus('success', `Case ${result.case_id} created successfully!`);
        
        // Reset form
        setTimeout(() => {
            if (confirm('Case created! Create another case?')) {
                resetForm();
            } else {
                window.location.href = '/';
            }
        }, 1500);

    } catch (error) {
        console.error('Failed to create case:', error);
        showStatus('error', `Failed to create case: ${error.message}`);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Case';
    }
}

function showStatus(type, message) {
    const statusDiv = document.getElementById('statusMessage');
    statusDiv.className = `status-message ${type}`;
    statusDiv.textContent = message;
    statusDiv.style.display = 'block';
    
    setTimeout(() => {
        statusDiv.style.display = 'none';
    }, 5000);
}

window.resetForm = function() {
    document.getElementById('caseForm').reset();
    uploadedImages = [];
    uploadedVideos = [];
    uploadedReferences = [];
    document.getElementById('uploadedImages').innerHTML = '';
    document.getElementById('uploadedVideos').innerHTML = '';
    document.getElementById('uploadedReferences').innerHTML = '';
    document.getElementById('rubricList').innerHTML = `
        <li class="rubric-item">
            <input type="text" placeholder="e.g., names study type" class="rubric-point">
            <button type="button" class="btn ghost" onclick="this.parentElement.remove()">Remove</button>
        </li>
    `;
}

// Logout
document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('jwt');
    window.location.href = '/login.html';
});

// Initialize
checkAdminAccess();
setupImageUpload();
setupVideoUpload();
setupReferenceUpload();

// Bind events
document.getElementById('caseForm').addEventListener('submit', submitCase);
document.getElementById('addRubricBtn').addEventListener('click', addRubricPoint);
document.getElementById('subspecialty').addEventListener('change', suggestNextCaseId);