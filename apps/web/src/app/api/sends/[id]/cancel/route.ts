import { decideSend } from "../decision";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return decideSend(request, params, "cancel");
}
