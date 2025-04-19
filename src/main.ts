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
let outlineDestMap: Map<HTMLElement, { pageIndex: number, top: number | null }> | null = null; // Map outline elements to page indices

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

  eventBus.on('pagesloaded', () => {
    console.log('PDFViewer: pagesloaded event (via EventBus)');
    const pageCount = pdfViewer?.pagesCount || 'N/A';
    setStatus(`Loaded: ${pageCount} pages`);
    pdfLinkService?.setDocument(currentPdfDocument, null);
    // Fetch and render the outline AFTER the document is loaded in the viewer
    fetchAndRenderOutline();
  });

  // Listener for scroll/view area changes to update outline highlight
  eventBus.on('updateviewarea', (evt: { location: any }) => {
    // Ensure map and location exist
    if (!outlineDestMap || !evt.location || !pdfViewer) return; // Add pdfViewer check

    // --- Use Destination Coordinates ---
    const currentScroll = pdfViewer.container.scrollTop; // Use container scroll
    const currentCenter = currentScroll + pdfViewer.container.clientHeight / 2; // Approx center

    // Find the page view nearest the center of the viewport
    // PDFViewer stores page views; we need to find which one is currently visible
    let visiblePageView = pdfViewer.getPageView(0); // Default to first page
    for (let i = 0; i < pdfViewer.pagesCount; i++) {
        const pageView = pdfViewer.getPageView(i);
        if (!pageView?.div) continue; // Skip if page view not rendered/ready

        const pageTop = pageView.div.offsetTop;
        const pageBottom = pageTop + pageView.div.clientHeight;

        // Check if the center of the viewport falls within this page's bounds
        if (currentCenter >= pageTop && currentCenter < pageBottom) {
            visiblePageView = pageView;
            break; // Found the most relevant page
        }
        // Fallback: if scrolled past the last page's top, use the last page
        if (i === pdfViewer.pagesCount - 1 && currentScroll >= pageTop) {
             visiblePageView = pageView;
        }
    }

    if (!visiblePageView?.pdfPage) {
        console.warn("Could not determine visible page view.");
        return; // Cannot proceed without a valid page view
    }

    const currentPageIndex = visiblePageView.id - 1; // pageView.id is 1-based page number
    const pageViewport = visiblePageView.viewport; // Use the viewport of the visible page

    // Calculate the scroll position *within* the current page, relative to its top-left (PDF coords)
    // scrollTop is relative to the container, pageTop is the page's offset within the container
    const scrollWithinPage = currentScroll - visiblePageView.div.offsetTop;
    // Convert viewport scroll position to PDF coordinate system (usually y increases downwards)
    // Note: This might need adjustment based on viewport rotation
    const currentY = pageViewport.convertToPdfPoint(0, scrollWithinPage)[1];

    let bestMatchElement: HTMLElement | null = null;
    let bestMatchPage = -1;
    let bestMatchTop = -Infinity; // Use -Infinity to correctly find the max top <= currentY

    // Iterate through the stored outline destinations
    outlineDestMap.forEach((destInfo: { pageIndex: number; top: number | null }, element: HTMLElement) => {
        // Check if this destination is "above or at" the current scroll position
        const isAboveOrAt = (
            destInfo.pageIndex < currentPageIndex ||
            (destInfo.pageIndex === currentPageIndex && destInfo.top !== null && destInfo.top >= currentY)
            // Note: PDF Y-coords often increase downwards, so a higher 'top' value means lower on the page.
            // We want the *highest* 'top' value that is still >= currentY (meaning just above or at the scroll position).
            // If your coordinate system is inverted (Y increases upwards), flip the comparison: destInfo.top <= currentY
        );

        if (isAboveOrAt) {
            // Check if this is a "better" match than the current best
            // Prioritize page index first, then the 'top' coordinate
            if (destInfo.pageIndex > bestMatchPage) {
                bestMatchPage = destInfo.pageIndex;
                bestMatchTop = destInfo.top ?? -Infinity; // Use -Infinity if top is null
                bestMatchElement = element;
            } else if (destInfo.pageIndex === bestMatchPage && (destInfo.top ?? -Infinity) > bestMatchTop) {
                // On the same page, find the one with the highest 'top' value (closest below or at currentY)
                bestMatchTop = destInfo.top ?? -Infinity;
                bestMatchElement = element;
            }
        }
    });

    // Update highlighting
    if (bestMatchElement && bestMatchElement !== lastOutlineHighlight) {
        if (lastOutlineHighlight) {
            lastOutlineHighlight.classList.remove('active');
        }
        (bestMatchElement as HTMLElement).classList.add('active');
        // Scroll outline view to keep active item visible
        (bestMatchElement as HTMLElement).scrollIntoView({ block: 'nearest' });
        lastOutlineHighlight = bestMatchElement;
    } else if (!bestMatchElement && lastOutlineHighlight) {
        // Scrolled before the first outline item
        lastOutlineHighlight.classList.remove('active');
        lastOutlineHighlight = null;
    }
  });

  console.log("PDF.js components initialized.");
  setStatus("Ready. Open a PDF file or enter a URL.");
}

// --- Outline Handling ---
async function fetchAndRenderOutline() {
  if (!currentPdfDocument) return;

  clearOutline(); // Clear previous outline
  outlineDestMap = new Map(); // Reset page map

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
  if (!currentPdfDocument || !pdfLinkService || !outlineDestMap) return;

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'outlineItem';

    const a = document.createElement('a');
    a.textContent = item.title || 'Untitled';
    if (item.bold) a.style.fontWeight = 'bold';
    if (item.italic) a.style.fontStyle = 'italic';
    // Note: item.color requires more complex handling to apply

    let destinationPageIndex: number | null = null;
    let destinationTop: number | null = null;

    if (item.dest) {
      try {
        // Resolve destination (string or array) to get page index
        const explicitDest = typeof item.dest === 'string'
          ? await currentPdfDocument.getDestination(item.dest)
          : item.dest;

        console.log(explicitDest);


        if (Array.isArray(explicitDest) && explicitDest[0] && typeof explicitDest[0] === 'object' && explicitDest[0].num !== undefined) {
          // Get page index (0-based)
          destinationPageIndex = await currentPdfDocument.getPageIndex(explicitDest[0]); // Get page object to resolve ref

          // Try to get 'top' coordinate, primarily from 'XYZ' type
          if (explicitDest[1] && typeof explicitDest[1] === 'object' && explicitDest[1].name === 'XYZ') {
             // explicitDest looks like [pageRef, {name: 'XYZ'}, left, top, zoom]
             // The actual top value might be null if not specified
             destinationTop = explicitDest[3] as number | null;
             // PDF coordinates often measure from top-left, but viewer might use different origin.
             // For 'XYZ', 'top' is usually distance from the *top* edge of the page.
             // Higher 'top' values mean lower down the page.
             // We might need to invert this if comparing with scroll position measuring from top.
             // Let's assume for now higher value = lower on page.
             // If scroll sync seems inverted, adjust here (e.g., pageHeight - top).
          } else if (explicitDest[1] && typeof explicitDest[1] === 'object' && (explicitDest[1].name === 'FitV' || explicitDest[1].name === 'FitBV')) {
             // For FitV/FitBV, the coordinate is the left edge, top is implicitly 0 (top edge)
             destinationTop = 0;
          } else if (explicitDest[1] && typeof explicitDest[1] === 'object' && (explicitDest[1].name === 'FitH' || explicitDest[1].name === 'FitBH')) {
             // For FitH/FitBH, the coordinate is the top edge.
             destinationTop = explicitDest[2] as number | null;
          } else {
             // For Fit, FitB, or unknown/unhandled types, we can't easily get a 'top' coord.
             // Treat as top of the page for scroll sync purposes.
             destinationTop = 0; // Default to top of page if no specific coord
             console.log("Outline item type doesn't provide specific top coord:", item.title, explicitDest[1]?.name);
          }
        } else {
          console.warn("Could not resolve destination page index for:", item.title, item.dest);
        }
      } catch (destError) {
        console.warn("Error resolving destination for:", item.title, destError);
      }

      if (destinationPageIndex !== null) {
        // Store page index for scroll syncing
        outlineDestMap.set(li, { pageIndex: destinationPageIndex, top: destinationTop });

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
  outlineDestMap = null;
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
