import Foundation
import Vision
import AppKit

// OCR a folder of page photos into a folder of .txt files using Apple Vision.
// macOS only (Vision is a system framework). No cost, runs on-device.
//
// Usage: swift scripts/ocr.swift <inputDir-of-jpgs> <outputDir-for-txt>
//
// Notes:
// - recognitionLevel = .accurate + usesLanguageCorrection = true is the best
//   quality Vision offers.
// - Observations are sorted top-to-bottom, then left-to-right within a line
//   band, to recover natural reading order. This works for single-column prose.
//   Multi-column tables/figures still scramble; those pages are re-transcribed
//   later with a vision model (see deploy/modal_ocr.py).
let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("need <inputDir> <outputDir>\n".data(using: .utf8)!)
    exit(1)
}
let inputDir = args[1], outputDir = args[2]
let fm = FileManager.default
try? fm.createDirectory(atPath: outputDir, withIntermediateDirectories: true)

let files = ((try? fm.contentsOfDirectory(atPath: inputDir)) ?? [])
    .filter { $0.lowercased().hasSuffix(".jpg") }.sorted()

var done = 0
for file in files {
    let path = (inputDir as NSString).appendingPathComponent(file)
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("SKIP \(file)"); continue
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([request])
    let obs = request.results ?? []
    // Reading order: top-to-bottom, then left-to-right within a ~1.5% line band.
    let sorted = obs.sorted { a, b in
        if abs(a.boundingBox.maxY - b.boundingBox.maxY) > 0.015 {
            return a.boundingBox.maxY > b.boundingBox.maxY
        }
        return a.boundingBox.minX < b.boundingBox.minX
    }
    let text = sorted.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    let out = (outputDir as NSString).appendingPathComponent(
        (file as NSString).deletingPathExtension + ".txt")
    try? text.write(toFile: out, atomically: true, encoding: .utf8)
    done += 1
    print("OK \(file) -> \(text.count) chars")
}
print("=== OCR'd \(done)/\(files.count) pages ===")
