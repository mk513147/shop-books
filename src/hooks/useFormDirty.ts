import { useEffect, useRef, useState } from "react";

export function useFormDirty<T>(values: T) {
	const initialRef = useRef<string>(JSON.stringify(values));
	const [isDirty, setIsDirty] = useState(false);

	useEffect(() => {
		const current = JSON.stringify(values);
		setIsDirty(current !== initialRef.current);
	}, [values]);

	const resetDirty = (newValues?: T) => {
		const base = newValues ?? values;
		initialRef.current = JSON.stringify(base);
		setIsDirty(false);
	};

	return { isDirty, resetDirty };
}
