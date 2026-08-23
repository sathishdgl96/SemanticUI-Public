import { useMutation, useQueryClient } from "@tanstack/react-query";
import { setFavorite, type ItemType } from "../api/library";

export function FavoriteStar({
  itemType,
  id,
  favorite,
  invalidate,
}: {
  itemType: ItemType;
  id: string;
  favorite: boolean;
  invalidate: string;
}) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => setFavorite(itemType, id, !favorite),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [invalidate] }),
  });
  return (
    <button
      type="button"
      className={favorite ? "star star-on" : "star"}
      aria-label={favorite ? "Unpin" : "Pin"}
      aria-pressed={favorite}
      disabled={toggle.isPending}
      // The row is a link: without this the pin would navigate as well.
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        toggle.mutate();
      }}
    >
      {favorite ? "★" : "☆"}
    </button>
  );
}
