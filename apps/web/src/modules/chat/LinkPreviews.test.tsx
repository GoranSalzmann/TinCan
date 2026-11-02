// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkPreview } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useSession } from "../../core/session/store.js";
import { LinkPreviews, PreviewCard } from "./LinkPreviews.js";

const preview = (over: Partial<LinkPreview> = {}): LinkPreview => ({
  url: "https://example.com/post",
  siteName: "Example",
  title: "A <b>title</b>",
  description: "Text with <script>alert(1)</script> inside",
  image: "a".repeat(64),
  imageWidth: 640,
  imageHeight: 320,
  video: false,
  ...over,
});

function setEnabled(enabled: boolean | null) {
  useSession.setState({
    capabilities: {
      features: enabled === null ? {} : { "link-previews": { enabled } },
    } as never,
  });
}

let n = 0;
const id = () => `m${++n}`;

beforeEach(() => setEnabled(true));
afterEach(() => vi.restoreAllMocks());

describe("PreviewCard", () => {
  it("shows provider text as text and the image from this server only", () => {
    const { container } = render(<PreviewCard preview={preview()} onRemove={null} />);
    expect(screen.getByRole("link", { name: "A <b>title</b>" })).toHaveAttribute(
      "href",
      "https://example.com/post",
    );
    expect(screen.getByText("Text with <script>alert(1)</script> inside")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(`/api/v1/link-previews/image/${"a".repeat(64)}`);
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("opens in a new tab without an opener or referrer", () => {
    render(<PreviewCard preview={preview({ image: null })} onRemove={null} />);
    const a = screen.getByRole("link");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("rel")).toContain("noreferrer");
  });

  it("names videos in words, not only with the play badge", () => {
    render(<PreviewCard preview={preview({ video: true })} onRemove={null} />);
    expect(screen.getByText("Example · Video")).toBeInTheDocument();
  });

  it("falls back to the host when the page had no title", () => {
    render(
      <PreviewCard
        preview={preview({ title: null, siteName: null, image: null, description: null })}
        onRemove={null}
      />,
    );
    expect(screen.getByRole("link", { name: "example.com" })).toBeInTheDocument();
  });

  it("offers removal only when allowed", () => {
    const onRemove = vi.fn();
    const { rerender } = render(<PreviewCard preview={preview()} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove preview" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    rerender(<PreviewCard preview={preview()} onRemove={null} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("LinkPreviews", () => {
  it("asks the server once for a message with a link and shows the cards", async () => {
    const spy = vi.spyOn(api, "linkPreviews").mockResolvedValue({ previews: [preview()] });
    const mid = id();
    const { rerender } = render(
      <LinkPreviews
        messageId={mid}
        content="see https://example.com/post"
        editedAt={null}
        canRemove={false}
      />,
    );
    expect(await screen.findByRole("link", { name: /title/ })).toBeInTheDocument();
    rerender(
      <LinkPreviews
        messageId={mid}
        content="see https://example.com/post"
        editedAt={null}
        canRemove={false}
      />,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when previews are off, or the message has no link", async () => {
    const spy = vi.spyOn(api, "linkPreviews").mockResolvedValue({ previews: [preview()] });
    setEnabled(false);
    const { container, rerender } = render(
      <LinkPreviews messageId={id()} content="https://example.com" editedAt={null} canRemove={false} />,
    );
    setEnabled(null);
    rerender(
      <LinkPreviews messageId={id()} content="https://example.com" editedAt={null} canRemove={false} />,
    );
    setEnabled(true);
    rerender(<LinkPreviews messageId={id()} content="no links here" editedAt={null} canRemove={false} />);
    rerender(
      <LinkPreviews
        messageId={id()}
        content="`https://example.com` in code"
        editedAt={null}
        canRemove={false}
      />,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing when the server has nothing or fails", async () => {
    vi.spyOn(api, "linkPreviews").mockRejectedValue(new Error("boom"));
    const { container } = render(
      <LinkPreviews messageId={id()} content="https://example.com" editedAt={null} canRemove={false} />,
    );
    await waitFor(() => expect(api.linkPreviews).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("removes the previews through the server and hides them", async () => {
    vi.spyOn(api, "linkPreviews").mockResolvedValue({ previews: [preview()] });
    const remove = vi.spyOn(api, "removeLinkPreviews").mockResolvedValue(undefined);
    const mid = id();
    render(<LinkPreviews messageId={mid} content="https://example.com/post" editedAt={null} canRemove />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove preview" }));
    await waitFor(() => expect(screen.queryByRole("article")).toBeNull());
    expect(remove).toHaveBeenCalledWith(mid);
  });
});
