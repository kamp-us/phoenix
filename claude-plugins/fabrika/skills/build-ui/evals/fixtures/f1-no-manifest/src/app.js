const list = document.getElementById("note-list");
["ilk not", "ikinci not"].forEach((t) => {
	const li = document.createElement("li");
	li.textContent = t;
	list.appendChild(li);
});
