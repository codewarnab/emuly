import { phoneApi } from "../../../../../lib/api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return phoneApi().keep(request, id);
}
