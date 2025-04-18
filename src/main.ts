import * as pdfjsLib from "pdfjs-dist";
// Import the CSS for the viewer components
import 'pdfjs-dist/web/pdf_viewer.css';
// Import the worker script
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Import necessary viewer components
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
// Optional components (add later if needed)
// import { PDFFindController } from 'pdfjs-dist/web/pdf_find_controller.mjs';
// import { PDFThumbnailViewer } from 'pdfjs-dist/web/pdf_thumbnail_viewer.mjs';

// --- Type Aliases ---
// Add types used by components if needed for stricter typing
type PDFDocumentProxy = pdfjsLib.PDFDocumentProxy;

// --- DOM Element References ---
const viewerContainer = document.getElementById('viewerContainer')!;
const viewerDiv = document.getElementById('viewer')!; // The div for PDFViewer
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const urlInput = document.getElementById('url-input') as HTMLInputElement;
const urlButton = document.getElementById('url-button') as HTMLButtonElement;
const statusMessage = document.getElementById('status-message') as HTMLSpanElement;
const dropZone = document.getElementById('drop-zone') as HTMLDivElement;
const body = document.body;
const zoomOutButton = document.getElementById('zoomOut') as HTMLButtonElement;
const zoomInButton = document.getElementById('zoomIn') as HTMLButtonElement;
const zoomSelect = document.getElementById('zoomSelect') as HTMLSelectElement;
const errorWrapper = document.getElementById('errorWrapper')!;
const errorMessage = document.getElementById('errorMessage')!;
const errorCloseButton = document.getElementById('errorClose') as HTMLButtonElement;

// --- PDF.js Setup ---
pdfjsLib.GlobalWorkerOptions.workerSrc = PdfjsWorker;
console.log("Using bundled pdf.js worker from:", PdfjsWorker);

// --- Viewer Component Setup ---
let pdfViewer: PDFViewer | null = null;
let pdfLinkService: PDFLinkService | null = null;
let eventBus: EventBus | null = null;
let currentPdfDocument: PDFDocumentProxy | null = null;

// --- Enums (using fallback values as types are inconsistent) ---
const LinkTarget_BLANK = 2;
const TextLayerMode_ENABLE = 1;
// const AnnotationMode_ENABLE_FORMS = 2; // Or 1 for ENABLE

function initializePdfJsComponents() {
  eventBus = new EventBus();

  pdfLinkService = new PDFLinkService({
    eventBus: eventBus,
    // External links open in a new window/tab.
    externalLinkTarget: LinkTarget_BLANK,
  });

  pdfViewer = new PDFViewer({
    container: viewerContainer as HTMLDivElement, // Scrollable container
    viewer: viewerDiv as HTMLDivElement, // Div where pages are appended
    eventBus: eventBus,
    linkService: pdfLinkService,
    // Enable text selection layer
    textLayerMode: TextLayerMode_ENABLE, // we use the fallback value
    // Enable annotation rendering layer
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS, // Or ENABLE
    // Use high-resolution rendering
    // Other options...
    // findController: pdfFindController, // Add later if implementing search
    // pdfScriptingManager: pdfScriptingManager, // For interactive forms/JS
    // downloadManager: downloadManager,
  });

  pdfLinkService.setViewer(pdfViewer); // Link service needs the viewer instance

  // --- Event Bus Listeners ---
  eventBus.on('pagesinit', () => {
    console.log('PDFViewer: pagesinit event');
    // Fit page to container initially, or use stored scale
    pdfViewer!.currentScaleValue = 'page-width'; // Or 'auto', 'page-fit'
    updateZoomControls();
  });

  eventBus.on('scalechanging', (evt: { scale: number; presetValue?: string }) => {
    console.log(`PDFViewer: scalechanging event - scale: ${evt.scale}, preset: ${evt.presetValue}`);
    updateZoomControls(evt.presetValue || String(evt.scale));
  });

  eventBus.on('documentload', () => {
    console.log('PDFViewer: documentload event (via EventBus)');
    // This event fires when the document is loaded *by the viewer*
    const pageCount = pdfViewer?.pagesCount || 'N/A';
    setStatus(`Loaded: ${pageCount} pages`);
    // Set initial document properties in link service
    pdfLinkService?.setDocument(currentPdfDocument, null);
  });

  eventBus.on('pagerendered', (evt: { pageNumber: number, source: any }) => {
      // Can be used for progress indication or lazy loading logic
      // console.log(`Page ${evt.pageNumber} rendered`);
      // Check if it's the last page to update status
      if (pdfViewer && evt.pageNumber === pdfViewer.pagesCount) {
          console.log("All pages rendered (or rendering initiated)");
          // Status already set by documentload, but could update here
      }
  });

  console.log("PDF.js components initialized.");
  setStatus("Ready. Open a PDF file or enter a URL.");
}

// --- Loading Function ---
async function loadPdf(source: File | string) {
  if (!pdfViewer || !eventBus) {
    showError("Viewer components not initialized.");
    return;
  }

  setStatus("Loading PDF...");
  console.log("Opening PDF source:", source);

  // Clean up previous document
  if (currentPdfDocument) {
    await currentPdfDocument.destroy();
    currentPdfDocument = null;
    pdfViewer.setDocument(null as any); // Clear the viewer
    pdfLinkService?.setDocument(null, null); // Clear link service
  }

  let loadingTask: pdfjsLib.PDFDocumentLoadingTask;
  if (source instanceof File) {
    try {
      const fileData = await source.arrayBuffer();
      loadingTask = pdfjsLib.getDocument({ data: fileData });
    } catch (readError) {
      showError(`Error reading file: ${readError instanceof Error ? readError.message : readError}`);
      return;
    }
  } else {
    loadingTask = pdfjsLib.getDocument(source);
  }

  try {
    currentPdfDocument = await loadingTask.promise;
    console.log("PDF document loaded via getDocument");

    // Pass the document to the viewer component
    pdfViewer.setDocument(currentPdfDocument);
    // Link service needs the document too (already handled by 'documentload' event listener)
    // pdfLinkService.setDocument(currentPdfDocument, null);

    // Status message will be updated by the 'documentload' event listener

  } catch (error) {
    let message = "Unknown error";
    if (error instanceof Error) {
        message = error.message;
    } else if (typeof error === 'string') {
        message = error;
    }
    console.error("Error loading PDF document:", error);
    showError(`Failed to load PDF: ${message}`);
    currentPdfDocument = null; // Ensure cleanup
    pdfViewer.setDocument(null as any); // Clear viewer on error
  }
}

// --- UI Helper Functions ---
function setStatus(message: string) {
  statusMessage.textContent = message;
}

function showError(message: string) {
    console.error("Viewer Error:", message);
    errorMessage.textContent = message;
    errorWrapper.hidden = false;
    setStatus("Error"); // Update general status
}

function hideError() {
    errorWrapper.hidden = true;
}

function updateZoomControls(presetValue?: string) {
    if (!pdfViewer) return;

    let currentScale = presetValue || String(pdfViewer.currentScaleValue);

    // If it's a numeric scale, format it as percentage for display
    const numericScale = parseFloat(currentScale);
    if (!isNaN(numericScale)) {
        currentScale = Math.round(numericScale * 100) + "%";
    }

    // Find or add the option in the select dropdown
    let found = false;
    for (let i = 0; i < zoomSelect.options.length; i++) {
        const option = zoomSelect.options[i];
        if (option?.value === pdfViewer.currentScaleValue || option?.text === currentScale) {
            zoomSelect.selectedIndex = i;
            found = true;
            break;
        }
    }

    // If the exact numeric scale wasn't a preset, add it temporarily? (Optional)
    // Or just reflect the closest preset if `presetValue` is available.
    if (!found && presetValue) {
         // Try to select based on preset value if available
         for (let i = 0; i < zoomSelect.options.length; i++) {
            if (zoomSelect.options[i]?.value === presetValue) {
                zoomSelect.selectedIndex = i;
                found = true;
                break;
            }
         }
    }

    // If still not found (e.g., custom scale), leave selection as is or set to blank/custom
    if (!found) {
        console.log("Scale value not found in presets:", pdfViewer.currentScaleValue);
        // Optionally add a custom option or clear selection
    }
}


// --- Event Listeners ---

// Initialize components when DOM is ready
document.addEventListener('DOMContentLoaded', initializePdfJsComponents);

// 1. File Input
fileInput.addEventListener('change', (event) => {
  hideError();
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file && file.type === 'application/pdf') {
    loadPdf(file);
    target.value = '';
  } else if (file) {
    showError('Invalid file type selected. Please choose a PDF.');
  }
});

// 2. URL Input
urlButton.addEventListener('click', () => {
  hideError();
  const url = urlInput.value.trim();
  if (url) {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      loadPdf(url);
    } else {
      showError('Invalid URL. Please enter a valid HTTP/HTTPS URL.');
    }
  } else {
    setStatus('Please enter a URL.');
  }
});
urlInput.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') {
    urlButton.click();
  }
});

// 3. Drag and Drop
body.addEventListener('dragover', (event) => {
  event.preventDefault();
  event.stopPropagation();
  body.classList.add('dragging');
});
body.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null || !body.contains(event.relatedTarget as Node)) {
    body.classList.remove('dragging');
  }
});
body.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  body.classList.remove('dragging');
  hideError();

  const files = event.dataTransfer?.files;
  const file = files?.[0];

  if (file && file.type === 'application/pdf') {
    loadPdf(file);
  } else if (file) {
    showError('Invalid file type dropped. Please drop a PDF file.');
  } else {
    const url = event.dataTransfer?.getData('URL') || event.dataTransfer?.getData('text/uri-list');
    if (url && (url.startsWith('http://') || url.startsWith('https://')) && url.toLowerCase().endsWith('.pdf')) {
      urlInput.value = url;
      loadPdf(url);
    } else {
      setStatus('Could not handle dropped item. Drop a PDF file or URL.');
    }
  }
});

// 4. Zoom Controls
zoomInButton.addEventListener('click', () => {
  if (pdfViewer) {
    pdfViewer.currentScaleValue = String(pdfViewer.currentScale * 1.1);
  }
});

zoomOutButton.addEventListener('click', () => {
  if (pdfViewer) {
    pdfViewer.currentScaleValue = String(pdfViewer.currentScale / 1.1);
  }
});

zoomSelect.addEventListener('change', () => {
  if (pdfViewer) {
    const selectedValue = zoomSelect.value;
    if (selectedValue === 'custom') { // Handle potential custom scale input later
        return;
    }
    pdfViewer.currentScaleValue = selectedValue;
  }
});

// 5. Error Close Button
errorCloseButton.addEventListener('click', hideError);
