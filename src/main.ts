import * as pdfjsLib from "pdfjs-dist";
import 'pdfjs-dist/web/pdf_viewer.css';
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import {
    EventBus,
    PDFLinkService,
    PDFViewer,
    // AnnotationMode // Import if needed for enum value
} from 'pdfjs-dist/web/pdf_viewer.mjs'; // Or viewer.mjs

// --- Type Aliases ---
type PDFDocumentProxy = pdfjsLib.PDFDocumentProxy;
// Define types for outline items based on pdf.js structure
type OutlineNode = {
    title: string;
    bold: boolean;
    italic: boolean;
    color: Uint8ClampedArray | null;
    dest: Array<any> | string | null; // Destination array or named destination string
    url: string | null;
    unsafeUrl: string | undefined;
    newWindow: boolean | undefined;
    count?: number; // Optional page count (often for collapsed sections)
    items: Array<OutlineNode>; // Nested items
};

// --- DOM Element References ---
const viewerContainer = document.getElementById('viewerContainer')!;
const viewerDiv = document.getElementById('viewer')!;
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
// Sidebar elements
const outlineView = document.getElementById('outlineView')!;
const thumbnailView = document.getElementById('thumbnailView')!; // Keep reference
const viewOutlineButton = document.getElementById('viewOutline') as HTMLButtonElement;
const viewThumbnailButton = document.getElementById('viewThumbnail') as HTMLButtonElement; // Keep reference

// --- PDF.js Setup ---
pdfjsLib.GlobalWorkerOptions.workerSrc = PdfjsWorker;

// --- Viewer Component Setup ---
let pdfViewer: PDFViewer | null = null;
let pdfLinkService: PDFLinkService | null = null;
let eventBus: EventBus | null = null;
let currentPdfDocument: PDFDocumentProxy | null = null;
let lastOutlineHighlight: HTMLElement | null = null; // Track highlighted item
let outlineData: OutlineNode[] | null = null; // Store fetched outline data
let outlinePageMap: Map<HTMLElement, number> | null = null; // Map outline elements to page indices

// --- Enums (using fallback values) ---
const LinkTarget_BLANK = 2;
const TextLayerMode_ENABLE = 1;
const AnnotationMode_ENABLE_FORMS = 2;

function initializePdfJsComponents() {
  eventBus = new EventBus();

  pdfLinkService = new PDFLinkService({
    eventBus: eventBus,
    externalLinkTarget: LinkTarget_BLANK,
  });

  pdfViewer = new PDFViewer({
    container: viewerContainer as HTMLDivElement,
    viewer: viewerDiv as HTMLDivElement,
    eventBus: eventBus,
    linkService: pdfLinkService,
    textLayerMode: TextLayerMode_ENABLE,
    annotationMode: AnnotationMode_ENABLE_FORMS,
  });

  pdfLinkService.setViewer(pdfViewer);

  // --- Event Bus Listeners ---
  eventBus.on('pagesinit', () => {
    console.log('PDFViewer: pagesinit event');
    pdfViewer!.currentScaleValue = 'page-width';
    updateZoomControls();
  });

  eventBus.on('scalechanging', (evt: { scale: number; presetValue?: string }) => {
    updateZoomControls(evt.presetValue || String(evt.scale));
  });

  eventBus.on('documentload', () => {
    console.log('PDFViewer: documentload event (via EventBus)');
    const pageCount = pdfViewer?.pagesCount || 'N/A';
    setStatus(`Loaded: ${pageCount} pages`);
    pdfLinkService?.setDocument(currentPdfDocument, null);
    // Fetch and render the outline AFTER the document is loaded in the viewer
    fetchAndRenderOutline();
  });

  // Listener for scroll/view area changes to update outline highlight
  eventBus.on('updateviewarea', (evt: { location: any }) => {
    // Ensure map and location exist
    if (!outlinePageMap || !evt.location) return;

    const currentPageIndex = evt.location.pageNumber - 1; // 0-based index
    let bestMatchElement: HTMLElement | null = null;
    let bestMatchPageIndex = -1;

    // Find the best matching outline item based on page index
    outlinePageMap.forEach((pageIndex: number, element: HTMLElement) => { // Explicit types can sometimes help
        if (pageIndex <= currentPageIndex && pageIndex > bestMatchPageIndex) {
            bestMatchPageIndex = pageIndex;
            bestMatchElement = element;
        }
    });

    // --- Start Modification ---
    // Update highlighting using clearer conditional structure

    // Case 1: Found a best match
    if (bestMatchElement) {
        // Only update if it's different from the currently highlighted item
        if (bestMatchElement !== lastOutlineHighlight) {
            // Remove highlight from the old item (if any)
            if (lastOutlineHighlight) {
                lastOutlineHighlight.classList.remove('active');
            }
            // Add highlight to the new item (TypeScript should know it's HTMLElement here)
            (bestMatchElement as HTMLElement).classList.add('active');
            // Optional: Scroll the outline view
            // bestMatchElement.scrollIntoView({ block: 'nearest' });
            // Update the tracker
            lastOutlineHighlight = bestMatchElement;
        }
    // Case 2: No match found (e.g., scrolled before first item)
    } else {
        // If something was highlighted previously, remove it
        if (lastOutlineHighlight) {
            lastOutlineHighlight.classList.remove('active');
            lastOutlineHighlight = null; // Reset tracker
        }
    }
    // --- End Modification ---
  });

  console.log("PDF.js components initialized.");
  setStatus("Ready. Open a PDF file or enter a URL.");
}

// --- Outline Handling ---
async function fetchAndRenderOutline() {
    if (!currentPdfDocument) return;

    clearOutline(); // Clear previous outline
    outlinePageMap = new Map(); // Reset page map

    try {
        outlineData = await currentPdfDocument.getOutline();
        if (!outlineData || outlineData.length === 0) {
            console.log("Document has no outline.");
            outlineView.innerHTML = '<em>No outline available.</em>';
            return;
        }

        console.log("Outline data fetched:", outlineData);
        const rootUl = document.createElement('ul');
        rootUl.className = 'outlineLevel';
        // Start recursive rendering
        await renderOutlineLevel(outlineData, rootUl);
        outlineView.appendChild(rootUl);

    } catch (error) {
        console.error("Error fetching or rendering outline:", error);
        outlineView.innerHTML = '<em>Error loading outline.</em>';
    }
}

async function renderOutlineLevel(items: OutlineNode[], container: HTMLUListElement) {
    if (!currentPdfDocument || !pdfLinkService || !outlinePageMap) return;

    for (const item of items) {
        const li = document.createElement('li');
        li.className = 'outlineItem';

        const a = document.createElement('a');
        a.textContent = item.title || 'Untitled';
        if (item.bold) a.style.fontWeight = 'bold';
        if (item.italic) a.style.fontStyle = 'italic';
        // Note: item.color requires more complex handling to apply

        let destinationPageIndex: number | null = null;

        if (item.dest) {
            try {
                // Resolve destination (string or array) to get page index
                const explicitDest = typeof item.dest === 'string'
                    ? await currentPdfDocument.getDestination(item.dest)
                    : item.dest;

                if (Array.isArray(explicitDest) && explicitDest[0] && typeof explicitDest[0] === 'object' && explicitDest[0].num) {
                    // Destination is an array, first element is page ref obj
                    destinationPageIndex = explicitDest[0].num - 1; // 0-based index
                } else {
                     console.warn("Could not resolve destination page index for:", item.title, item.dest);
                }
            } catch (destError) {
                console.warn("Error resolving destination for:", item.title, destError);
            }

            if (destinationPageIndex !== null) {
                // Store page index for scroll syncing
                outlinePageMap.set(li, destinationPageIndex); // Map the LI element

                // Add click listener for navigation
                a.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation(); // Prevent potential parent clicks
                    if (pdfLinkService && item.dest) {
                        console.log("Navigating to destination:", item.dest);
                        // Use goToDestination for both named and explicit destinations
                        pdfLinkService.goToDestination(item.dest)
                            .catch(navError => console.error("Navigation error:", navError));

                        // Immediately highlight clicked item (optional, scroll sync will catch up)
                        if (lastOutlineHighlight) lastOutlineHighlight.classList.remove('active');
                        li.classList.add('active');
                        lastOutlineHighlight = li;
                    }
                });
            } else {
                 a.style.cursor = 'default'; // Indicate non-clickable if no valid dest page
                 a.style.opacity = '0.7';
            }

        } else if (item.url) {
            // Handle external URLs if needed (less common for internal outline)
            a.href = item.url;
            a.target = '_blank'; // Open external links in new tab
            a.style.cursor = 'alias'; // Indicate external link
        } else {
            a.style.cursor = 'default'; // No action
            a.style.opacity = '0.7';
        }

        li.appendChild(a);
        container.appendChild(li);

        // Recursively render nested items
        if (item.items && item.items.length > 0) {
            const nestedUl = document.createElement('ul');
            nestedUl.className = 'outlineLevel';
            li.appendChild(nestedUl);
            await renderOutlineLevel(item.items, nestedUl); // Await recursive calls
        }
    }
}

function clearOutline() {
    outlineView.innerHTML = ''; // Clear previous content
    lastOutlineHighlight = null; // Reset highlight tracking
    outlineData = null;
    outlinePageMap = null;
}

// --- Loading Function ---
async function loadPdf(source: File | string) {
  if (!pdfViewer || !eventBus) {
    showError("Viewer components not initialized.");
    return;
  }

  setStatus("Loading PDF...");
  console.log("Opening PDF source:", source);
  clearOutline(); // Clear outline when starting to load new PDF

  // Clean up previous document
  if (currentPdfDocument) {
    await currentPdfDocument.destroy();
    currentPdfDocument = null;
    pdfViewer.setDocument(null as any);
    pdfLinkService?.setDocument(null, null);
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
    pdfViewer.setDocument(currentPdfDocument);
    // Outline fetching/rendering is now triggered by the 'documentload' event from eventBus

  } catch (error) {
    let message = "Unknown error";
    if (error instanceof Error) { message = error.message; }
    else if (typeof error === 'string') { message = error; }
    console.error("Error loading PDF document:", error);
    showError(`Failed to load PDF: ${message}`);
    currentPdfDocument = null;
    pdfViewer.setDocument(null as any);
  }
}

// --- UI Helper Functions ---
function setStatus(message: string) { statusMessage.textContent = message; }
function showError(message: string) { console.error("Viewer Error:", message); errorMessage.textContent = message; errorWrapper.hidden = false; setStatus("Error"); }
function hideError() { errorWrapper.hidden = true; }

function updateZoomControls(presetValue?: string) {
    if (!pdfViewer) return;
    let currentScale = presetValue || String(pdfViewer.currentScaleValue);
    const numericScale = parseFloat(currentScale);
    if (!isNaN(numericScale)) { currentScale = Math.round(numericScale * 100) + "%"; }
    let found = false;
    for (let i = 0; i < zoomSelect.options.length; i++) {
        const option = zoomSelect.options[i];
        if (option?.value === pdfViewer.currentScaleValue || option?.text === currentScale) { zoomSelect.selectedIndex = i; found = true; break; }
    }
    if (!found && presetValue) {
         for (let i = 0; i < zoomSelect.options.length; i++) { if (zoomSelect.options[i]?.value === presetValue) { zoomSelect.selectedIndex = i; found = true; break; } }
    }
    if (!found) { console.log("Scale value not found in presets:", pdfViewer.currentScaleValue); }
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', initializePdfJsComponents);

// File Input
fileInput.addEventListener('change', (event) => { hideError(); const target = event.target as HTMLInputElement; const file = target.files?.[0]; if (file && file.type === 'application/pdf') { loadPdf(file); target.value = ''; } else if (file) { showError('Invalid file type selected. Please choose a PDF.'); } });
// URL Input
urlButton.addEventListener('click', () => { hideError(); const url = urlInput.value.trim(); if (url) { if (url.startsWith('http://') || url.startsWith('https://')) { loadPdf(url); } else { showError('Invalid URL. Please enter a valid HTTP/HTTPS URL.'); } } else { setStatus('Please enter a URL.'); } });
urlInput.addEventListener('keypress', (event) => { if (event.key === 'Enter') { urlButton.click(); } });
// Drag and Drop
body.addEventListener('dragover', (event) => { event.preventDefault(); event.stopPropagation(); body.classList.add('dragging'); });
body.addEventListener('dragleave', (event) => { if (event.relatedTarget === null || !body.contains(event.relatedTarget as Node)) { body.classList.remove('dragging'); } });
body.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); body.classList.remove('dragging'); hideError(); const files = event.dataTransfer?.files; const file = files?.[0]; if (file && file.type === 'application/pdf') { loadPdf(file); } else if (file) { showError('Invalid file type dropped. Please drop a PDF file.'); } else { const url = event.dataTransfer?.getData('URL') || event.dataTransfer?.getData('text/uri-list'); if (url && (url.startsWith('http://') || url.startsWith('https://')) && url.toLowerCase().endsWith('.pdf')) { urlInput.value = url; loadPdf(url); } else { setStatus('Could not handle dropped item. Drop a PDF file or URL.'); } } });
// Zoom Controls
zoomInButton.addEventListener('click', () => { if (pdfViewer) { pdfViewer.currentScale = pdfViewer.currentScale * 1.1; } });
zoomOutButton.addEventListener('click', () => { if (pdfViewer) { pdfViewer.currentScale = pdfViewer.currentScale / 1.1; } });
zoomSelect.addEventListener('change', () => { if (pdfViewer) { const selectedValue = zoomSelect.value; if (selectedValue === 'custom') { return; } pdfViewer.currentScaleValue = selectedValue; } });
// Error Close Button
errorCloseButton.addEventListener('click', hideError);

// Sidebar View Toggles
viewOutlineButton.addEventListener('click', () => {
    outlineView.classList.remove('hidden');
    thumbnailView.classList.add('hidden');
    viewOutlineButton.classList.add('toggled'); // Add 'toggled' class for styling if needed
    viewThumbnailButton.classList.remove('toggled');
});

viewThumbnailButton.addEventListener('click', () => {
    thumbnailView.classList.remove('hidden');
    outlineView.classList.add('hidden');
    viewThumbnailButton.classList.add('toggled');
    viewOutlineButton.classList.remove('toggled');
    // Add logic here later if/when thumbnail view is implemented
    console.log("Thumbnail view selected (not implemented yet).");
});

// Set initial sidebar view (e.g., outline visible by default)
document.addEventListener('DOMContentLoaded', () => {
    viewOutlineButton.click(); // Programmatically click outline button initially
});
