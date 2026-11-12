import { expect, test } from "vitest";
import { localImage } from "./local-files";

test.each<[string, string, string | undefined]>([
  ["a Windows path, as Markdown encodes it", "C:%5Cshots%5Chome.png", "C:\\shots\\home.png"],
  ["a Windows path with forward slashes", "C:/shots/home.png", "C:/shots/home.png"],
  ["a POSIX path with a space", "/tmp/my%20shot.PNG", "/tmp/my shot.PNG"],
  ["a file URL to a Windows path", "file:///C:/shots/home.png", "C:/shots/home.png"],
  ["a file URL to a POSIX path", "file:///tmp/home.png", "/tmp/home.png"],
  ["a web address", "https://example.com/home.png", undefined],
  ["a web address without its scheme", "//cdn.example.com/home.png", undefined],
  ["a relative path", "shots/home.png", undefined],
  ["a file that is not an image", "/tmp/notes.txt", undefined],
])("localImage reads %s", (_, url, expected) => {
  expect(localImage(url)).toBe(expected);
});
