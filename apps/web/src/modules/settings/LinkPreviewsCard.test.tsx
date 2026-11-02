// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_PREVIEW_DEFAULT_ALLOW, type LinkPreviewSettings } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useSession } from "../../core/session/store.js";
import { LinkPreviewsCard } from "./LinkPreviewsCard.js";

const defaults: LinkPreviewSettings = {
  enabled: false,
  allowAll: false,
  allowDomains: [...LINK_PREVIEW_DEFAULT_ALLOW],
  denyDomains: [],
};

beforeEach(() => {
  useSession.setState({ capabilities: { features: { "link-previews": { enabled: false } } } as never });
});

const allowBox = () => screen.getByLabelText<HTMLTextAreaElement>("Allowed sites (one per line)");

describe("link previews card", () => {
  it("shows the default list from the first visit and says what it does", async () => {
    vi.spyOn(api, "linkPreviewSettings").mockResolvedValue(defaults);
    render(<LinkPreviewsCard />);
    await waitFor(() => expect(allowBox()).not.toBeDisabled());
    expect(allowBox().value.split("\n")).toEqual([...LINK_PREVIEW_DEFAULT_ALLOW]);
    expect(screen.getByText(/Only these sites, and their subdomains, are visited/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Allow all sites/)).not.toBeChecked();
  });

  it("turning previews on sends the default list, never 'all sites'", async () => {
    vi.spyOn(api, "linkPreviewSettings").mockResolvedValue(defaults);
    const save = vi
      .spyOn(api, "setLinkPreviewSettings")
      .mockImplementation(async (b) => ({ ...defaults, ...b }));
    render(<LinkPreviewsCard />);
    await waitFor(() => expect(allowBox()).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText("Show previews of links in messages"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith({
      enabled: true,
      allowAll: false,
      allowDomains: [...LINK_PREVIEW_DEFAULT_ALLOW],
      denyDomains: [],
    });
  });

  it("restores the defaults", async () => {
    vi.spyOn(api, "linkPreviewSettings").mockResolvedValue({ ...defaults, allowDomains: ["example.org"] });
    render(<LinkPreviewsCard />);
    await waitFor(() => expect(allowBox().value).toBe("example.org"));
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    expect(allowBox().value.split("\n")).toEqual([...LINK_PREVIEW_DEFAULT_ALLOW]);
  });

  it("warns when all sites are allowed, and the list is then not used", async () => {
    vi.spyOn(api, "linkPreviewSettings").mockResolvedValue(defaults);
    render(<LinkPreviewsCard />);
    await waitFor(() => expect(allowBox()).not.toBeDisabled());
    fireEvent.click(screen.getByLabelText(/Allow all sites/));
    expect(screen.getByRole("alert")).toHaveTextContent(/Any public site/);
    expect(allowBox()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore defaults" })).toBeDisabled();
  });

  it("says an empty list allows nothing, and refuses a bad name", async () => {
    vi.spyOn(api, "linkPreviewSettings").mockResolvedValue(defaults);
    render(<LinkPreviewsCard />);
    await waitFor(() => expect(allowBox()).not.toBeDisabled());
    fireEvent.change(allowBox(), { target: { value: "" } });
    expect(screen.getByRole("status")).toHaveTextContent(/no site gets a preview/);
    fireEvent.change(allowBox(), { target: { value: "not a domain!" } });
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent(/Not a site name/);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
